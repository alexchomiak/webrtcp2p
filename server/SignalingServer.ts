import { Server as WebSocketServer, AddressInfo } from 'ws'
import { EventEmitter } from 'events'
import { Socket } from 'net'

interface SignalingServerProps {
    port: number
    verbose: boolean
}

interface SignalMessage {
    source: Socket
    type: string
    payload: any
}

interface Peer {
    ip: String
    connection: Socket
}

interface Channel {
    id: string
    peers: string[]
}

export class SignalingServer extends EventEmitter {
    #wss: WebSocketServer
    #port: number
    #verbose: boolean
    #channels: Map<string, Channel>
    #pendingOffers: Map<string, string>
    #connections: Map<string, boolean>
    #peerMap: Map<string, Peer>
    #emitter: EventEmitter
    /**
     *
     * @param {Object} config signaling server configuration options
     * @param {number} options.port specifies application port for signaling server
     * @param {boolean} options.verbose log incoming connections
     * @param {DataStore} options.datastore data store to be used for persisted data
     */
    public constructor({ port, verbose }: SignalingServerProps) {
        super()
        this.#wss = new WebSocketServer({ port })
        this.#port = port
        this.#verbose = verbose !== undefined ? verbose : false
        this.#channels = new Map<string, Channel>()
        this.#pendingOffers = new Map<string, string>()
        this.#connections = new Map<string, boolean>()
        this.#peerMap = new Map<string, Peer>()

        // * Install Handlers
        this.#wss.on('connection', this.connectionHandler)

        // * Setup Event Emiiter
        this.#emitter = new EventEmitter()
    }

    /**
     *
     * @param {Socket} connection incoming connection socket object
     */
    private connectionHandler(connection: Socket): void {
        // * Log incoming connection if verbose logging enabled
        if (this.#verbose) {
            console.log(`Incoming connection from ${(connection.address() as AddressInfo).address}`)
        }

        // * Set Connection in Peer map
        this.#peerMap.set((connection.address() as AddressInfo).address, {
            ip: (connection.address() as AddressInfo).address,
            connection
        })

        // * Install Handlers for connection
        connection.on('message', (message: MessageEvent) => {
            let data: SignalMessage
            // * Manage Signaling Messages
            try {
                // * Parse data from message object
                data = JSON.parse(message.data) as SignalMessage
                data.source = connection

                // * Check if message is correct format
                if (!data.type || !data.payload) {
                    throw new Error('Message incorrectly formatted')
                }
            } catch (err) {
                connection.end()
                console.error(
                    `Signaling message incorrectly formatted, is NOT JSON or NOT correctly a formatted message, aborted connection\n Recieved ${data.toString()}`
                )
            }
            try {
                // * Handle message
                switch (data.type) {
                    case 'join-pool':
                        this.joinPool(data)
                        break
                    case 'offer':
                        this.relayOffer(data)
                        break
                    case 'answer':
                        this.relayAnswer(data)
                        break
                    case 'candidate':
                        this.passCandidate(data)
                        break
                    case 'keep-alive':
                        // TODO: Keep Alive packet to notify server connection is still alive, expecting keepalive packets every ~30s
                        // to remain in peer pool
                        break
                    case 'kill':
                        // TODO Handle killing of peer connection
                        break
                }
            } catch (err) {
                console.error(
                    `Signaling message incorrectly formatted, is NOT a correctly formatted message\n Recieved ${data.toString()}`
                )
                console.error(err.message)
            }
        })
    }

    /**
     * @description Relays WebRTC answer from peer to peer
     * @author Alex Chomiak
     * @date 2020-05-15
     * @private
     * @param {SignalMessage} data object that contains answer in payload
     * @memberof SignalingServer
     */
    private relayAnswer(data: SignalMessage) {
        interface AnswerMessage extends SignalMessage {
            payload: {
                target: string
                answer: RTCOfferAnswerOptions
                channel: string
            }
        }

        // * Cast message to answer type
        const message = data as AnswerMessage

        // * Check if required properties on payload
        const { payload } = message
        if (!payload.target) throw new Error('target property not found on message payload')
        if (!payload.channel) throw new Error('channel property not found on message payload')
        if (!payload.channel) throw new Error('answer property not found on message payload')

        // * * * Check if peer has pending offer from target
        const offer = this.#pendingOffers.get(
            `pendingOffers/${payload.channel}/${payload.target}/${
                (message.source.address() as AddressInfo).address
            }`
        )

        if (!offer) throw Error("Offer doesn't exist for given target!")

        // * * * Grab peer associated with offer
        const channel = this.#channels.get(payload.channel)

        if (!channel) throw new Error("Channel doesn't exist")
        const peer: string = channel.peers.find(peer => peer == payload.target)
        if (!peer) throw new Error('Peer not in channel!')

        // * Update pending offers
        this.#pendingOffers.delete(
            `pendingOffers/${payload.channel}/${payload.target}/${
                (message.source.address() as AddressInfo).address
            }`
        )

        // * Relay answer to peer
        this.#peerMap.get(peer).connection.write(
            JSON.stringify({
                type: 'answer',
                payload: {
                    source: (data.source.address() as AddressInfo).address,
                    answer: payload.answer
                }
            })
        )

        // * Add Connection to connection store (both directions)
        this.#connections.set(
            `${payload.channel}/${(data.source.address() as AddressInfo).address}#${
                payload.target
            }`,
            true
        )
        this.#connections.set(
            `${payload.channel}/${payload.target}#${
                (data.source.address() as AddressInfo).address
            }`,
            true
        )

        // * Emit event indicating peers have upgraded
        this.#emitter.emit('p2pupgrade', [
            (data.source.address() as AddressInfo).address,
            payload.target
        ])
    }

    /**
     * @description Relays WebRTC offer from peer to peer
     * @author Alex Chomiak
     * @date 2020-05-15
     * @private
     * @param {SignalMessage} data object that contains offer in payload
     * @memberof SignalingServer
     */
    private relayOffer(data: SignalMessage) {
        interface OfferMessage extends SignalMessage {
            payload: {
                target: string
                offer: RTCOfferOptions
                channel: string
            }
        }

        // * Cast message to Offer Type
        const message = data as OfferMessage

        // * Check if required properties on payload
        const { payload } = message
        if (!payload.target) throw new Error('target property not found on message payload')
        if (!payload.channel) throw new Error('channel property not found on message payload')
        if (!payload.offer) throw new Error('offer property not found on message payload')

        // * * * Check if peer in channel with offerer
        // * Grab Channel from data store
        const channel = this.#channels.get(payload.channel)

        if (!channel) throw new Error("Channel doesn't exist")
        const peer: string = channel.peers.find(peer => peer == payload.target)
        if (!peer) throw new Error('Peer not in channel!')

        // * Put offer into pending pending offers store
        this.#pendingOffers.set(
            `pendingOffers/${channel}/${(message.source.address() as AddressInfo).address}/${
                payload.target
            }`,
            'pending'
        )

        // * Relay offer to peer
        this.#peerMap.get(peer).connection.write(
            JSON.stringify({
                type: 'offer',
                payload: {
                    source: (data.source.address() as AddressInfo).address,
                    offer: payload.offer
                }
            })
        )
    }

    /**
     * @description Adds peer to Channel in which peers can discover one another and initialize p2p connections
     * @param {SignalMessage} data object that contains pool information
     */
    private joinPool(data: SignalMessage) {
        interface JoinPoolMessage extends SignalMessage {
            payload: {
                channel: string
            }
        }

        const message = data as JoinPoolMessage
        const { payload } = message
        if (!payload.channel) throw new Error('channel property not set in payload')
        // * Get channel
        const channel = this.#channels.get(payload.channel)
        if (!channel) {
            this.#channels.set(payload.channel, {
                id: payload.channel,
                peers: [(message.source.address() as AddressInfo).address]
            })
        } else {
            channel.peers.push((message.source.address() as AddressInfo).address)
        }
    }

    /**
     * @description Relays ICE Candidates to other peers
     * @author Alex Chomiak
     * @date 2020-05-15
     * @private
     * @param {SignalMessage} data containing ice candidate information
     * @memberof SignalingServer
     */
    private passCandidate(data: SignalMessage) {
        interface CandidateMessage extends SignalMessage {
            payload: {
                target: string
                candidate: RTCIceCandidate
            }
        }
        const message = data as CandidateMessage
        const { payload } = message

        // * * * If so, relay candidate to target
        this.#peerMap.get(payload.target).connection.write(
            JSON.stringify({
                type: 'candidate',
                payload: {
                    candidate: payload.candidate
                }
            })
        )
    }
    /**
     * @description
     * @author Alex Chomiak
     * @date 2020-05-15
     * @returns {number} Port of Signaling Server
     * @memberof SignalingServer
     */
    public getPort() {
        return this.#port
    }
}
