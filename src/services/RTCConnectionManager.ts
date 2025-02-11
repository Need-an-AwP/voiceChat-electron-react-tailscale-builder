import sendViaTailscale from "@/utils/tailscaleProxy"
import { useRTC, useTailscale, useBlankStreams, useMediaStream, useDB, useRemoteUserStore, useChannel } from "@/stores"
import type { RTCMessage, setReceivedStream, IPs, RTCStatus, UserConfig, VoiceChannel } from "@/types"
import { useMirror, MirrorState } from "@/stores/mirrorStates"

class RTCConnectionManager {
    private targetPeerIP: string;
    private readonly isOffer: boolean;
    private rtcLocalPC: RTCPeerConnection | null = null;
    private iceCandidates: RTCIceCandidate[] = []
    private dataChannel: RTCDataChannel | null = null;
    private pingInterval: NodeJS.Timeout | null = null;
    private pingTimeOut: NodeJS.Timeout | null = null;
    private offerWaitingTimer: NodeJS.Timeout | null = null;
    private pingTime: number = 0;
    private updateStatus: (updates: Partial<RTCStatus>) => void
    private setReceivedAudioStream: setReceivedStream;
    private setReceivedVideoStream: setReceivedStream;
    private trackHasAudio: boolean = false;
    private trackHasVideo: boolean = false;
    // get tailscale state
    private get selfIPs() {
        return useTailscale.getState().selfIPs
    }
    // get blank streams
    private get blankVideoStream() {
        return useBlankStreams.getState().blankVideoStream;
    }
    private get blankAudioStream() {
        return useBlankStreams.getState().blankAudioStream;
    }
    // get channel store
    private get channelStore() {
        return useChannel.getState();
    }

    constructor(targetPeerIP: string, isOffer: boolean) {
        this.targetPeerIP = targetPeerIP
        this.isOffer = isOffer
        // init rtc connection depends on offer or answer
        this.init()
        // init status manger
        const rtcStore = useRTC.getState();
        this.updateStatus = (updates: Partial<RTCStatus>) => rtcStore.updateStatus(this.targetPeerIP, updates);
        rtcStore.setStatus(this.targetPeerIP, {
            state: 'initializing',
            latency: 0,
            peer: null,
            dataChannel: null,
            isOffer: this.isOffer,
            userConfig: null
        });


        // get media stream store
        this.setReceivedAudioStream = useMediaStream.getState().setReceivedAudioStream
        this.setReceivedVideoStream = useMediaStream.getState().setReceivedVideoStream

    }

    private init() {
        if (this.isOffer) {
            this.createRTCConnection()
        } else {
            this.waitOffer()
        }
    }

    private shouldAskOffer() {

    }

    private waitOffer() {
        if (this.offerWaitingTimer) {
            clearInterval(this.offerWaitingTimer);
        }
        this.offerWaitingTimer = setInterval(() => {
            // "checking" | "closed" | "completed" | "connected" | "disconnected" | "failed" | "new";
            if (!this.rtcLocalPC) {
                console.log(`go ask for offer from ${this.targetPeerIP}`);
                sendViaTailscale(this.targetPeerIP, {
                    type: 'ask-offer',
                    sender: { ipv4: this.selfIPs.ipv4, ipv6: this.selfIPs.ipv6 },
                } as RTCMessage);
            } else if (['waiting', 'failed', 'closed'].includes(this.rtcLocalPC.iceConnectionState)) {
                console.log(`wait ${this.targetPeerIP} timeout, ask offer again`);
                sendViaTailscale(this.targetPeerIP, {
                    type: 'ask-offer',
                    sender: { ipv4: this.selfIPs.ipv4, ipv6: this.selfIPs.ipv6 },
                } as RTCMessage);
            }
        }, 6000);
    }

    // create rtc connection as offer provider
    public async createRTCConnection() {
        await this.cleanUp()

        if (!this.blankAudioStream || !this.blankVideoStream) {
            throw new Error('Blank streams not initialized')
        }
        const audioStream = this.blankAudioStream
        const videoStream = this.blankVideoStream

        const pc = new RTCPeerConnection()
        this.rtcLocalPC = pc

        // add blank voice tracks
        audioStream.getTracks().forEach(track => {
            pc.addTrack(track, audioStream)
        })

        // add blank video tracks
        videoStream.getTracks().forEach(track => {
            pc.addTrack(track, videoStream)
        })

        const dc = pc.createDataChannel('data', { ordered: false });
        this.setupDataChannel(dc);

        pc.onicecandidate = (e) => {
            if (e.candidate) {
                this.iceCandidates.push(e.candidate)
            }
        }

        pc.onicegatheringstatechange = async () => {
            if (pc.iceGatheringState === 'complete') {
                try {
                    await sendViaTailscale(this.targetPeerIP, {
                        type: 'offer-with-candidates',
                        sender: {
                            ipv4: this.selfIPs.ipv4,
                            ipv6: this.selfIPs.ipv6
                        },
                        offer: pc.localDescription,
                        candidates: this.iceCandidates
                    } as RTCMessage)
                } catch (err) {
                    console.error('Error sending offer:', err)
                }
            }
        }

        pc.oniceconnectionstatechange = () => {
            console.log('offer side ICE connection state:', pc.iceConnectionState);
            this.updateStatus({
                state: pc.iceConnectionState,
                latency: 0
            });
        };

        pc.ontrack = (e) => {
            const { streams, track, transceiver } = e;
            // judge stream type from track number XD
            if (streams[0].getTracks().length === 2) {
                console.log('offer side received video stream');
                this.setReceivedVideoStream(this.targetPeerIP, streams[0])
            } else if (streams[0].getTracks().length === 1) {
                console.log('offer side received voice stream');
                this.setReceivedAudioStream(this.targetPeerIP, streams[0])
            }
        }

        // create offer after all listeners are set
        try {
            const offer = await pc.createOffer()
            await pc.setLocalDescription(offer)
        } catch (err) {
            console.error('Error creating offer:', err)
            throw err
        }
    }

    public async replaceAudioTrack(finalStream: MediaStream) {
        if (!this.rtcLocalPC || this.trackHasAudio) return;

        const senders = this.rtcLocalPC.getSenders()
        senders.forEach(sender => {
            if (sender.track && sender.track.id === useBlankStreams.getState().blankTrackIds!['voice-audio']) {
                finalStream.getTracks().forEach(track => sender.replaceTrack(track))
            }
        });
        this.trackHasAudio = true;
        console.log('replaced audio track for ', this.targetPeerIP);
    }

    public async replaceVideoTrack({ stream, includeAudio = false }: { stream: MediaStream, includeAudio: boolean }) {
        if (!this.rtcLocalPC || this.trackHasVideo) return;

        const senders = this.rtcLocalPC.getSenders()
        senders.forEach(sender => {
            if (sender.track && sender.track.id === useBlankStreams.getState().blankTrackIds!['screen-video']) {
                stream.getVideoTracks().forEach(track => {
                    sender.replaceTrack(track)
                })
            } else if (includeAudio && sender.track && sender.track.id === useBlankStreams.getState().blankTrackIds!['screen-audio']) {
                stream.getAudioTracks().forEach(track => {
                    sender.replaceTrack(track)
                })
            }
        });
        this.trackHasVideo = true;
        console.log('replaced video track for ', this.targetPeerIP);
    }

    private setupDataChannel(dataChannel: RTCDataChannel) {
        this.dataChannel = dataChannel;
        this.updateStatus({ dataChannel });

        dataChannel.onopen = () => {
            console.log('data channel opened');

            this.pingInterval = setInterval(() => {
                dataChannel.send(JSON.stringify({ type: 'ping' }));
                this.pingTime = Date.now();
                this.pingTimeOut = setTimeout(() => {
                    this.updateStatus({ latency: -1 });
                }, 5000);
            }, 1000);

            // if (this.isDBinitialized) {
            //     dataChannel.send(JSON.stringify({
            //         type: 'user_config',
            //         config: this.selfConfig
            //         // trackId: blanktrackIdRef.current
            //     }));
            // }
            dataChannel.send(JSON.stringify({
                type: 'sync_status',
                status: useMirror.getState()
            }));


        }

        dataChannel.onmessage = (event) => {
            try {
                const data = JSON.parse(event.data)
                switch (data.type) {
                    default:
                        console.log('unknown data channel message type:', data.type);
                        break
                    case 'ping':
                        dataChannel.send(JSON.stringify({ type: 'pong' }))
                        break
                    case 'pong':
                        this.updateStatus({ latency: Date.now() - this.pingTime });
                        if (this.pingTimeOut) {
                            clearTimeout(this.pingTimeOut);
                            this.pingTimeOut = null;
                        }
                        break
                    // case 'user_config':
                    //     // receivedTrackIdRef.current[this.address] = data.trackId;
                    //     this.setUser(this.targetPeerIP, data.config)
                    //     console.log('user config received:', data.config);
                    //     break;
                    case 'sync_status':
                        this.handleSyncStatus(data.status);
                        break;

                }
            } catch (err) {
                console.error('data channel message error:', err);
            }
        }
    }

    private handleSyncStatus(status: MirrorState) {
        console.log('sync status received:', status);
        useRemoteUserStore.getState().updateRemoteUsersInfo(this.targetPeerIP, status)
        if (status.inVoiceChannel) {
            // prevent adding user which is already in this channel
            if (this.channelStore.users[status.inVoiceChannel.id]?.find(user => {
                if (user.id === status.user?.id) { return true }
            })) return;
            // both using preset channels
            if (status.isPresetChannels && this.channelStore.isPresetChannels) {
                this.channelStore.addUser(status.inVoiceChannel.id, status.user!)
            }
            // remote is using preset channels but local is not
            // or
            // local is using preset channels but remote is not
            else if (
                (status.isPresetChannels && !this.channelStore.isPresetChannels) ||
                (!status.isPresetChannels && this.channelStore.isPresetChannels)
            ) {
                // create new temporary channel and add user to it
                const tempChannelId = -(Math.abs(status.inVoiceChannel.id))
                this.channelStore.addChannel({
                    ...status.inVoiceChannel,
                    id: tempChannelId,
                    temporary: true
                } as VoiceChannel)
                this.channelStore.addUser(tempChannelId, status.user!)
            }
            // both not using preset channels
            else {
                this.channelStore.addUser(status.inVoiceChannel.id, status.user!)
            }
        } else {
            Object.keys(this.channelStore.users).forEach(channelId => {
                if (this.channelStore.users[+channelId]?.some(user => user.id === status.user!.id)) {
                    this.channelStore.removeUser(+channelId, status.user!.id);
                }
            });
        }
    }

    public async handleOfferWithCandidates(data: RTCMessage) {
        if (!this.blankAudioStream || !this.blankVideoStream) {
            throw new Error('Blank streams not initialized')
        }
        const audioStream = this.blankAudioStream
        const videoStream = this.blankVideoStream

        const { offer, candidates } = data
        if (!offer || !candidates) {
            throw new Error('offer or candidates not found')
        }

        const r_pc = new RTCPeerConnection()
        this.rtcLocalPC = r_pc;


        r_pc.onicecandidate = e => {
            if (e.candidate) {
                this.iceCandidates.push(e.candidate);
            }
        };

        r_pc.onicegatheringstatechange = () => {
            if (r_pc.iceGatheringState === 'complete') {
                console.log('Answer ICE gathering completed');
                // send answer and candidates together in one http request
                sendViaTailscale(data.sender.ipv4, {
                    type: 'answer-with-candidates',
                    sender: { ipv4: this.selfIPs.ipv4, ipv6: this.selfIPs.ipv6 },
                    answer: r_pc.localDescription,
                    candidates: this.iceCandidates
                } as RTCMessage);
            }
        };

        r_pc.oniceconnectionstatechange = () => {
            console.log('answer side ICE connection state:', r_pc.iceConnectionState);
            this.updateStatus({
                state: r_pc.iceConnectionState,
                latency: 0
            });
        };

        r_pc.ondatachannel = e => {
            this.setupDataChannel(e.channel);
        }

        r_pc.ontrack = (e) => {
            const { streams, track, transceiver } = e;

            if (streams[0].getTracks().length === 2) {
                console.log('answer side received video stream');
                this.setReceivedVideoStream(this.targetPeerIP, streams[0])
            } else if (streams[0].getTracks().length === 1) {
                console.log('answer side received voice stream');
                this.setReceivedAudioStream(this.targetPeerIP, streams[0])
            }
        }

        // add blank voice tracks
        audioStream.getTracks().forEach(track => {
            r_pc.addTrack(track, audioStream)
        })
        // add blank video tracks
        videoStream.getTracks().forEach(track => {
            r_pc.addTrack(track, videoStream)
        })

        // operate pc after setting all listeners
        await r_pc.setRemoteDescription(offer)
        const answer = await r_pc.createAnswer()
        await r_pc.setLocalDescription(answer)

        // add all ice candidates
        for (let ice of candidates) {
            try {
                await r_pc.addIceCandidate(ice)
            } catch (err) {
                console.error('Error adding ice candidate:', err);
            }
        }

    }

    public async handleAnswerWithCandidates(data: RTCMessage) {
        if (!this.rtcLocalPC) return;
        const { answer, candidates } = data
        if (!answer || !candidates) {
            throw new Error('answer or candidates not found')
        }

        this.rtcLocalPC.setRemoteDescription(answer)

        for (let ice of candidates) {
            try {
                await this.rtcLocalPC.addIceCandidate(ice)
            } catch (err) {
                console.error('Error adding ice candidate:', err);
            }
        }
    }

    private async cleanUp() {
        if (this.rtcLocalPC) {
            this.rtcLocalPC.onicecandidate = null
            this.rtcLocalPC.onicegatheringstatechange = null
            this.rtcLocalPC.oniceconnectionstatechange = null
            this.rtcLocalPC.ondatachannel = null
            this.rtcLocalPC.ontrack = null

            if (this.dataChannel) {
                this.dataChannel.close()
                this.dataChannel = null
            }

            if (this.pingInterval) {
                clearInterval(this.pingInterval)
                this.pingInterval = null
            }

            if (this.pingTimeOut) {
                clearTimeout(this.pingTimeOut)
                this.pingTimeOut = null
            }

            if (this.offerWaitingTimer) {
                clearInterval(this.offerWaitingTimer);
                this.offerWaitingTimer = null;
            }

            this.rtcLocalPC.close()
            this.rtcLocalPC = null
        }
    }
}

export default RTCConnectionManager;
