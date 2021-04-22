import { EncodeOutput } from "tsbuffer";
import { BaseServiceType, ServiceProto, TsrpcError, TsrpcErrorType } from "tsrpc-proto";
import { BaseClient, BaseClientOptions, defaultBaseClientOptions, PendingApiItem } from "./models/BaseClient";
import { ApiService, MsgService } from "./models/ServiceMapUtil";
import { TransportDataUtil } from "./models/TransportDataUtil";
import { TransportOptions } from "./models/TransportOptions";

export class HttpClient<ServiceType extends BaseServiceType> extends BaseClient<ServiceType> {

    readonly type = 'SHORT';

    readonly options!: HttpClientOptions;
    constructor(proto: ServiceProto<ServiceType>, options?: Partial<HttpClientOptions>) {
        super(proto, {
            ...defaultHttpClientOptions,
            ...options
        });
        this.logger?.log('TSRPC HTTP Client :', this.options.server);
    }

    lastReceivedBuf?: Uint8Array;

    protected _encodeApiReq(service: ApiService, req: any, pendingItem: PendingApiItem): EncodeOutput {
        if (this.options.json) {
            if (this.options.jsonPrune) {
                let opPrune = this.tsbuffer.prune(req, pendingItem.service.reqSchemaId);
                if (!opPrune.isSucc) {
                    return opPrune;
                }
                req = opPrune.pruneOutput;
            }
            return {
                isSucc: true,
                buf: JSON.stringify(req) as any
            }
        }
        else {
            return TransportDataUtil.encodeApiReq(this.tsbuffer, service, req, undefined);
        }
    }

    protected _encodeClientMsg(service: MsgService, msg: any): EncodeOutput {
        if (this.options.json) {
            if (this.options.jsonPrune) {
                let opPrune = this.tsbuffer.prune(msg, service.msgSchemaId);
                if (!opPrune.isSucc) {
                    return opPrune;
                }
                msg = opPrune.pruneOutput;
            }
            return {
                isSucc: true,
                buf: JSON.stringify(msg) as any
            }
        }
        else {
            return TransportDataUtil.encodeClientMsg(this.tsbuffer, service, msg);
        }
    }

    protected async _sendBuf(buf: Uint8Array, options: TransportOptions, serviceId: number, pendingApiItem?: PendingApiItem): Promise<{ err?: TsrpcError | undefined; }> {
        let sn = pendingApiItem?.sn;
        let promise = new Promise<{ err?: TsrpcError | undefined; }>(async rs => {
            // Pre Flow
            if (!this.options.json) {
                let pre = await this.flows.preSendBufferFlow.exec({ buf: buf, sn: pendingApiItem?.sn }, this.logger);
                if (!pre) {
                    return;
                }
                buf = pre.buf;
            }

            // Do Send
            this.options.debugBuf && this.logger?.debug('[SendBuf]' + (sn ? (' #' + sn) : ''), `length=${buf.length}`, buf);
            let xhr = new XMLHttpRequest();
            if (navigator.userAgent.indexOf('MSIE 8.0;') > -1) {
                //IE8 不支持onload onabort onerror事件
                xhr.onreadystatechange = async () => {
                    if (xhr.readyState == 4) {
                        //Network Error
                        if (xhr.status == 0 || (xhr.response == null && xhr.responseText == null)) {
                            rs({
                                err: new TsrpcError('Network Error', {
                                    type: TsrpcErrorType.NetworkError,
                                    httpCode: xhr.status
                                })
                            })
                            return;
                        }
                        this._onXhrRes(xhr, rs, pendingApiItem);
                    }
                }
            }
            else {
                xhr.onerror = () => {
                    rs({
                        err: new TsrpcError({
                            message: 'Network Error',
                            type: TsrpcErrorType.NetworkError,
                            httpCode: xhr.status
                        })
                    });
                }

                // 有的平台 超时不触发onerror
                xhr.ontimeout = () => {
                    rs({
                        err: new TsrpcError({
                            message: 'Request Timeout',
                            type: TsrpcErrorType.NetworkError,
                            code: 'TIMEOUT'
                        })
                    });
                }

                xhr.onload = async () => {
                    this._onXhrRes(xhr, rs, pendingApiItem);
                }

                if (options.onProgress) {
                    xhr.upload.onprogress = e => {
                        options.onProgress?.(e.loaded / e.total);
                    }
                }
            }
            xhr.open('POST', this.options.server, true);
            xhr.setRequestHeader('Content-Type', 'application/json');
            xhr.responseType = this.options.json ? 'text' : 'arraybuffer';
            let timeout = options.timeout ?? this.options.timeout;
            if (timeout) {
                xhr.timeout = timeout;
            }
            xhr.send(buf);

            if (pendingApiItem) {
                pendingApiItem.onAbort = () => {
                    xhr.onreadystatechange = null;
                    xhr.abort();
                }
            }
        });

        promise.catch().then(() => {
            if (pendingApiItem) {
                pendingApiItem.onAbort = undefined;
            }
        })

        return promise;
    }

    private async _onXhrRes(xhr: XMLHttpRequest, rs: (ret: { err?: TsrpcError }) => void, pendingApiItem?: PendingApiItem) {
        //IE9 wrongURL 会返回12029
        if (xhr.status == 12029) {
            rs({
                err: new TsrpcError({
                    message: 'Network Error',
                    type: TsrpcErrorType.NetworkError,
                    httpCode: xhr.status
                })
            })
            return;
        }

        // sendMsg not parse res
        if (!pendingApiItem) {
            rs({});
            return;
        }

        // JSON
        if (this.options.json) {
            
        }
        // ArrayBuffer
        else {
            let ab: ArrayBuffer = xhr.response;
            if (!ab) {
                rs({
                    err: new TsrpcError({
                        message: 'Response is empty',
                        type: TsrpcErrorType.ServerError,
                        code: 'EMPTY_RES',
                        httpCode: xhr.status
                    })
                })
                return;
            }
            let buf = new Uint8Array(ab);
            this._onRecvBuf(buf, pendingApiItem);
        }
    }

}

const defaultHttpClientOptions: HttpClientOptions = {
    ...defaultBaseClientOptions,
    server: 'http://localhost:3000',
    json: false,
    jsonPrune: true
}

export interface HttpClientOptions extends BaseClientOptions {
    /** Server URL */
    server: string;

    /** 
     * Use JSON instead of Buffer
     * @defaultValue false
     */
    json: boolean;
    /**
     * 是否剔除协议中未定义的多余字段
     * 默认为 `true`
     */
    jsonPrune: boolean;
}