import { create } from 'zustand'
import { isValidIPv4, isValidIPv6 } from '@/utils/ipValidation'
import type { TailscaleStore, TailscaleStatus, PeerData } from '@/types/internals/tailscaleStoreTypes'
import { initializeDB } from '@/stores'
import { initializeChannels } from '@/stores'

const useTailscale = create<TailscaleStore>()(
    (set) => ({
        status: null,
        selfIPs: {},
        loginName: null,
        isTailscaleAuthKey: false,

        setStatus: (status) => set({ status }),
        setSelfIPs: (ips) => set({ selfIPs: ips }),
        setLoginName: (name) => set({ loginName: name }),
        setIsTailscaleAuthKey: (isAuthKey) => set({ isTailscaleAuthKey: isAuthKey })
    })
)

const initializeTailscaleListeners = () => {
    window.ipcBridge.receive('tailscale-status', (status: TailscaleStatus) => {
        // console.log(status)
        if (!status.TailscaleIPs) return

        const store = useTailscale.getState()
        const selfUserID = status.Self.UserID;
        const filteredStatus: TailscaleStatus = {
            ...status,
            Peer: Object.entries(status.Peer).reduce<Record<string, PeerData>>(
                (acc, [key, peer]) => {
                    if (peer.UserID === selfUserID) {
                        acc[key] = peer;
                    }
                    return acc;
                },
                {}
            )
        };
        store.setStatus(filteredStatus);
        let ipv4, ipv6
        status.TailscaleIPs.map((ip: string) => {

            if (isValidIPv4(ip)) {
                ipv4 = ip
            } else if (isValidIPv6(ip)) {
                ipv6 = ip
            }
        })
        store.setSelfIPs({ ipv4, ipv6 });

        store.setLoginName(status.User?.[status.Self.UserID]?.LoginName);

        // init indexedDB after tailscale status has value
        initializeDB();
        // init channel store after tailscale status has value
        initializeChannels();
    })
}

export { useTailscale, initializeTailscaleListeners }