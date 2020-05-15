

// ** Client Socket Class */
export class Client {
    #signalServerConnection : RTCPeerConnection

    constructor() {
        this.#signalServerConnection = new RTCPeerConnection()
    }
}