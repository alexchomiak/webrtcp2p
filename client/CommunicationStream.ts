export class PeerCommunicationStream{
    #peerConnection : RTCPeerConnection
    constructor() {
        // * Initialize Peer Connection
       this.#peerConnection = new RTCPeerConnection() 
    }

    // * Connection Function
    async connect() {

    }

    getPeerConnection() {
        return this.#peerConnection
    }

}