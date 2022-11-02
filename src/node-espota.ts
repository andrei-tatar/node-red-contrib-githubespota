import {
    Subject, combineLatest, concat, defer, EMPTY,
    of, ReplaySubject, timer, Observable,
} from "rxjs";
import {
    catchError, finalize, first, mergeMap, retry, scan,
    share, shareReplay, switchMap, withLatestFrom
} from "rxjs/operators";
import { EspOta } from "./esp-ota";
import { fetch } from 'undici'
import { gte as versionGreaterOrEqual } from 'semver';

const VERSION_REGEX = /\d+\.\d+\.\d+/;

module.exports = function (RED: any) {
    RED.nodes.registerType('node-espota', function (this: NodeInterface, config: any) {
        RED.nodes.createNode(this, config);

        const versions$ = new Subject<{ host: string, version: string }>();
        const executeUpdate$ = new Subject<void>();
        const includeTopics = new RegExp(config.includeTopics);
        const excludeTopics = config.excludeTopics ? new RegExp(config.excludeTopics) : null;
        const firmwareLink = config.firmwareLink;
        if (!firmwareLink) {
            return;
        }

        const versionsByHost$ = defer(() => {
            const saved = this.context().get('versions');
            const savedMap = typeof saved === 'string' ? JSON.parse(saved) : [];
            return of(new Map<string, string>(savedMap));
        }).pipe(
            switchMap(savedMap =>
                versions$.pipe(
                    scan((map, current) => {
                        map.set(current.host, current.version);
                        const json = JSON.stringify([...map.entries()]);
                        this.context().set('versions', json)
                        return map;
                    }, new Map<string, string>(savedMap))
                ),
            ),
            share({
                connector: () => new ReplaySubject(1),
            }),
        );

        const latestVersion$ = defer(async () => {
            const latestFirmware = await fetch(firmwareLink, {
                redirect: 'manual',
            });

            if (latestFirmware.status != 302) {
                throw new Error('firmware needs to be a redirect');
            }

            const latestLocation = latestFirmware.headers.get('location');
            if (!latestLocation) {
                throw new Error('missing redirect with version');
            }

            const match = VERSION_REGEX.exec(latestLocation);
            if (!match) {
                throw new Error('missing version in the firmware redirect link');
            }

            const version = match[0];

            return {
                version,
                firmware$: defer(async () => {
                    const response = await fetch(latestLocation);
                    const blob = await response.blob();
                    const buffer = await blob.arrayBuffer();
                    return Buffer.from(buffer);
                }).pipe(
                    shareReplay(1),
                ),
            };
        });


        const ota = new EspOta();
        let updated = 0;
        let inProgress = 0;
        let total: number | undefined;
        let failed = 0;

        const updateStatus = (version?: string) => {
            this.status({
                fill: failed === 0 ? 'green' : 'red',
                text: inProgress === 0
                    ? (failed
                        ? `updated:${updated}/fail:${failed}`
                        : (total !== 0 ? 'idle' : 'all up to date')
                    )
                    : `updating ${version ? `to ${version}` : ''} ${updated}/${total} (${inProgress}${failed ? `, fail:${failed}` : ''})`,
                shape: inProgress === 0 ? 'ring' : 'dot,'
            });
        };

        const doTheUpdate$ = combineLatest([versionsByHost$, latestVersion$]).pipe(
            first(),
            switchMap(([versions, latest]) => {
                const execute$ = new ReplaySubject<Observable<void>>();

                total = 0;
                updated = 0;
                inProgress = 0;
                failed = 0;

                for (const [host, version] of versions) {
                    if (versionGreaterOrEqual(version, latest.version)) {
                        continue;
                    }

                    execute$.next(
                        concat(
                            defer(() => {
                                inProgress++;
                                updateStatus(latest.version);
                                return EMPTY;
                            }),
                            ota.upload({
                                host,
                                data: latest.firmware$,
                            }).pipe(
                                catchError(err => {
                                    this.error(err);
                                    failed++;
                                    updated--;
                                    return EMPTY;
                                }),
                            ),
                        ).pipe(finalize(() => {
                            updated++;
                            inProgress--;
                            updateStatus(latest.version);
                        })),
                    );

                    total++;
                }

                if (total === 0) {
                    updateStatus();
                }

                return execute$.pipe(
                    mergeMap(v => v, 2),
                );
            }),
            retry({
                delay: (err) => {
                    this.error(err);
                    this.status({
                        fill: 'red',
                        shape: 'ring',
                        text: 'something went wrong, check logs'
                    });
                    return timer(10000);
                },
            }),
        );

        const subscription =
            executeUpdate$.pipe(
                withLatestFrom(versionsByHost$),
                switchMap(_ => doTheUpdate$)
            ).subscribe();

        updateStatus();

        this.on('input', msg => {
            if (msg.topic === 'update') {
                executeUpdate$.next();
                return;
            }

            if (typeof msg.payload != 'string' || !msg.payload.length) {
                return;
            }

            const topic = msg.topic ?? '';
            if (!topic) {
                return;
            }

            const match = includeTopics.exec(topic);
            if (!match) {
                return;
            }

            if (excludeTopics && excludeTopics.exec(topic)) {
                return;
            }

            versions$.next({ host: `${match[1]}.local`, version: msg.payload });
        });

        this.on('close', () => subscription.unsubscribe());
    });
};

export interface NodeMessage {
    payload: any;
    topic?: string;
}

export interface NodeInterface {
    credentials: { [key: string]: string };

    on(type: 'input', callback: (msg: NodeMessage, send?: (msg: NodeMessage) => void, done?: (err?: any) => void) => void): void;
    on(type: 'close', callback: () => void): void;

    send(msg: any): void;

    log(msg: string): void;
    warn(msg: string): void;
    error(msg: string): void;

    status(params: {
        fill: 'red' | 'green' | 'yellow' | 'blue' | 'grey',
        text: string,
        shape: 'ring' | 'dot',
    } | {}): void;

    context(): {
        get<T>(key: string): T;
        set<T>(key: string, value: T): void;
    };
}
