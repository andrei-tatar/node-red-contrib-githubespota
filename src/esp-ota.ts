import { Observable, combineLatest, merge, ObservableInput } from 'rxjs';
import { concatMap, first, ignoreElements, retry, share, switchMap, timeout } from 'rxjs/operators';

import { createSocket, Socket as UdpSocket } from 'node:dgram';
import { createServer, Server, Socket as TcpSocket } from 'node:net';
import { lookup as dnsLookup } from 'node:dns';
import { createHash } from 'node:crypto';

export enum OtaTarget {
    Flash = 0,
    SpiFfs = 100,
    Auth = 200,
}

const DEFAULT_OPTIONS: Required<EspOtaOptions> = {
    chunkSize: 1460,
    serverPort: 0,
    timeout: 5000,
};

const DEFAULT_UPLOAD_OPTIONS: Required<Pick<UploadOptions, 'port' | 'target'>> = {
    port: 3232,
    target: OtaTarget.Flash,
}

export class EspOta {
    private options: Readonly<Required<EspOtaOptions>>;

    private socket$ = new Observable<UdpSocket>(observer => {
        const udpsocket = createSocket('udp4');
        udpsocket.on('error', (e) => observer.error(e));
        observer.next(udpsocket);
        return () => udpsocket.close();
    });

    private server$ = new Observable<Server>(observer => {
        const server = createServer();
        server.listen(this.options.serverPort, () => observer.next(server));
        server.on('error', (e) => observer.error(e));
        return () => server.close();
    });

    constructor(options?: EspOtaOptions) {
        this.options = { ...DEFAULT_OPTIONS, ...options };
    }

    upload(options: UploadOptions): Observable<never> {
        const opts = { ...DEFAULT_UPLOAD_OPTIONS, ...options };

        return combineLatest([this.socket$, this.server$, options.data, this.dns(options.host)]).pipe(
            switchMap(([socket, server, data, address]) => {
                return merge(
                    this.sendData(data, server),
                    this.sendInvitation(data, opts, address, socket, server)
                );
            }),
            first(),
            ignoreElements(),
        );
    }

    private sendData(data: Buffer, server: Server): Observable<any> {
        return new Observable<TcpSocket>(observer => {
            const handler = (socket: TcpSocket) => observer.next(socket);
            server.once('connection', handler);
            return () => server.off('connection', handler);
        }).pipe(
            switchMap(socket => {
                const rx$ = new Observable<Buffer>(observer => {
                    const dataHandler = (data: Buffer) => observer.next(data);
                    const errorHandler = (e: any) => observer.error(e);
                    socket.on('data', dataHandler);
                    socket.on('error', errorHandler);

                    return () => {
                        socket.off('data', dataHandler);
                        socket.off('error', errorHandler);
                        socket.destroy();
                    };
                }).pipe(
                    timeout(this.options.timeout),
                    share(),
                );

                const chunks$ = new Observable<Buffer>(observer => {
                    for (let index = 0; index < data.length; index += this.options.chunkSize) {
                        const chunk = data.subarray(index, index + this.options.chunkSize);
                        observer.next(chunk);
                    }
                    observer.complete();
                });

                const complete$ = rx$.pipe(
                    first(d => d.toString() === 'OK')
                );

                return merge(
                    complete$,
                    chunks$.pipe(
                        concatMap(chunk =>
                            merge(
                                rx$.pipe(first()), // wait for ack,
                                this.sendPacket(socket, chunk),
                            )
                        ),
                        ignoreElements(),
                    )
                );
            }),
        );
    }

    private sendPacket(socket: TcpSocket, data: Buffer) {
        return new Observable<never>(observer => {
            socket.write(data, (err) => {
                if (err) {
                    observer.error(err);
                } else {
                    observer.complete();
                }
            });
        });
    }

    private sendInvitation(data: Buffer, opts: UploadOptions, address: string, socket: UdpSocket, server: Server): Observable<never> {
        return new Observable<never>(observer => {
            const serverAddress = server.address();
            if (!serverAddress || typeof serverAddress !== 'object') {
                throw new Error('Invalid server address');
            }

            const buf = Buffer.from(`${opts.target} ${serverAddress.port} ${data.length} ${this.md5(data)}`);

            const handler = (data: Buffer) => {
                const stringData = data.toString();

                if (stringData.match(/OK/)) {
                    observer.complete();
                } else if (stringData.match(/AUTH/)) {
                    this.authenticate(opts, socket, stringData);
                }
            };
            socket.on('message', handler);

            socket.send(buf, 0, buf.length, opts.port, address);
            return () => socket.off('message', handler);
        }).pipe(
            timeout(2000),
            retry(5),
        );
    }

    private authenticate(opts: UploadOptions, socket: UdpSocket, data: string) {
        let match = data.match(/AUTH (\S+)/);
        if (match) {
            const nonce = match[1];
            const client_nonce = this.md5(nonce + opts.host + String(Date.now()));
            const challenge = `${opts.password}:${nonce}:${client_nonce}`;
            const md5sum = this.md5(challenge);

            const buf = Buffer.from(`${OtaTarget.Auth} ${client_nonce} ${md5sum}\n`);
            socket.send(buf, 0, buf.length, opts.port, opts.host);
        }
    }

    private md5(data: Buffer | string) {
        return createHash('md5').update(data).digest('hex');
    }

    private dns(host: string) {
        return new Observable<string>(observer => {
            dnsLookup(host, 4, (err, address) => {
                if (err) {
                    observer.error(err);
                } else {
                    observer.next(address);
                    observer.complete();
                }
            });
        });
    }
}

interface EspOtaOptions {
    serverPort?: number;
    chunkSize?: number;
    timeout?: number;
}

interface UploadOptions {
    host: string;
    data: ObservableInput<Buffer>;
    port?: number;
    target?: OtaTarget;
    password?: string;
}
