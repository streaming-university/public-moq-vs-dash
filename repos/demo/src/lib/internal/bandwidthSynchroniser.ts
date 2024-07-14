import { createContext, useContext } from "react";

export type BandwidthSettings = {
    bandwidth: string;
    isSyncEnabled: boolean;
};

export const BaseBandwidthSettings: BandwidthSettings = {
    bandwidth: "", // default bandwidth value
    isSyncEnabled: false,
};

// Context for bandwidth synchronizer
export const BandwidthContext = createContext<BandwidthSettings>(BaseBandwidthSettings);
export const useBandwidth = () => useContext(BandwidthContext);

export class BandwidthSynchroniser {
    #settings: BandwidthSettings = BaseBandwidthSettings;
    #bc: BroadcastChannel;

    constructor() {
        this.#bc = new BroadcastChannel("bandwidth_sync");
        this.#bc.onmessage = this.#synchronise.bind(this);
    }

    get settings(): BandwidthSettings {
        return this.#settings;
    }

    get channel(): BroadcastChannel {
        return this.#bc;
    }

    #synchronise({ data }: MessageEvent<BandwidthSettings>) {
        console.log("Received sync data", data);
        this.#settings = { ...data };
        console.log("Updated sync data", this.#settings)
    }

    updateSettings(bandwidth: string, isSyncEnabled: boolean) {
        this.#settings = { ...this.#settings, bandwidth, isSyncEnabled };
        this.#bc.postMessage(this.#settings);
    }
}

// BandwidthSynchroniser context
export const BandwidthSynchroniserContext = createContext<BandwidthSynchroniser>(new BandwidthSynchroniser());
export const useBandwidthSynchroniser = () => useContext(BandwidthSynchroniserContext);
