/**
 * WssServer的客户端
 */
import WebSocket from 'ws';
import CryptoJS from 'crypto-js';

export type WssBridgeListenerCallback = (message: any, params?: any[]) => void;
export type WssBridgeRequestCallback = (resp: WssBridgeResponse, params?: any[]) => void;
export type WssBridgeOnopen = (params?: any[]) => void;
export type WssBridgeOnclose = (code: number, reason: string, params?: any[]) => void;
export type WssBridgeOnerror = (error: any, params?: any[]) => void;
export type WssBridgeOnretry = (count: number, params?: any[]) => void;
export type WssBridgeOnsecond = (second: number, delay: number, params?: any[]) => void;

export class WssBridgePackData {
    /**
     * 路由
     */
    public static readonly ROUTE_HEARTICK = '$heartick$';//心跳包路由
    public static readonly ROUTE_RESPONSE = '$response$';//响应请求路由
    /**
     * 状态
     * 本框架保留状态码:
     * 4001-4100 服务端保留状态码范围
     * 4101-4200 客户端保留状态码范围
     * 4201-4999 可自定义的状态码范围
     */
    public static readonly CODE_RETRY = { code: 4101, data: 'retry' };
    public static readonly CODE_CLOSE = { code: 4102, data: 'close' };
    public static readonly CODE_ERROR = { code: 4103, data: 'error' };
    public static readonly CODE_CALL = { code: 4104, data: 'call' };

    public route: string;
    public reqId: number;
    public message: any;
    /**
     * @param route 路由
     * @param reqId 请求序号
     * @param message 报文数据
     */
    public constructor(route: string, reqId: number, message: any) {
        this.route = route;
        this.reqId = reqId;
        this.message = message;
    }
    /**
     * 将数据包进行序列化，采用随机生成iv和key的AES加密算法，CBC、Pkcs7
     * @param pack 要序列化的数据包
     * @param pwd 加密的密码
     * @param binary 是否返回二进制结果，设置了pwd时生效
     */
    public static serialize(pack: WssBridgePackData, pwd: string, binary: boolean): ArrayBuffer | string {
        try {
            const str = JSON.stringify(pack);
            if (pwd) {
                //ArrayBuffer or base64 string
                const salt = CryptoJS.lib.WordArray.random(16);
                const iv = CryptoJS.lib.WordArray.random(16);
                const key = CryptoJS.HmacSHA256(salt, pwd);
                const body = CryptoJS.AES.encrypt(str, key, {
                    iv: iv,
                    mode: CryptoJS.mode.CBC,
                    padding: CryptoJS.pad.Pkcs7
                }).ciphertext;
                const encRes = CryptoJS.lib.WordArray.create();
                encRes.concat(salt).concat(iv).concat(body);
                return binary ? new Int32Array(encRes.words).buffer : encRes.toString(CryptoJS.enc.Base64);
            } else {
                //json string
                return str;
            }
        } catch (e) {
            return null;
        }
    }
    /**
     * 将收到的数据进行反序列化，采用随机生成iv和key的AES解密算法，CBC、Pkcs7
     * @param data 要解密的数据
     * @param pwd 解密的密码
     */
    public static deserialize(data: ArrayBuffer | string, pwd: string): WssBridgePackData {
        try {
            if (pwd) {
                //ArrayBuffer or base64 string
                const words = data instanceof ArrayBuffer ? Array.prototype.slice.call(new Int32Array(data)) : CryptoJS.enc.Base64.parse(data).words;
                const salt = CryptoJS.lib.WordArray.create(words.slice(0, 4));
                const iv = CryptoJS.lib.WordArray.create(words.slice(4, 8));
                const key = CryptoJS.HmacSHA256(salt, pwd);
                const body = CryptoJS.lib.WordArray.create(words.slice(8));
                const decRes = CryptoJS.AES.decrypt(<any>{ ciphertext: body }, key, {
                    iv: iv,
                    mode: CryptoJS.mode.CBC,
                    padding: CryptoJS.pad.Pkcs7
                }).toString(CryptoJS.enc.Utf8);
                const obj = JSON.parse(decRes);
                return new WssBridgePackData(obj.route, obj.reqId, obj.message);
            } else {
                //json string
                const obj = data instanceof ArrayBuffer ? {} : JSON.parse(data);
                return new WssBridgePackData(obj.route, obj.reqId, obj.message);
            }
        } catch (e) {
            return null;
        }
    }
    /**
     * 计算md5编码
     * @param data 要计算编码的字符串
     */
    public static getMd5(data: string): string {
        return CryptoJS.MD5(data).toString();
    }
}
export class WssBridgeListener {
    public once: boolean;//是否只触发一次
    public onmessage: WssBridgeListenerCallback;
    public context: any;
    public params: any[];
    public constructor(once: boolean, onmessage: WssBridgeListenerCallback, context?: any, params?: any[]) {
        this.once = once;
        this.onmessage = onmessage;
        this.context = context || this;
        this.params = params;
    }
    public callMessage(message: any) {
        if (this.onmessage) {
            this.onmessage.call(this.context, message, this.params);
        }
    }
}
export class WssBridgeRequest {
    public time: number;//请求的时间
    public onsuccess: WssBridgeRequestCallback;
    public onerror: WssBridgeRequestCallback;
    public context: any;
    public params: any[];
    public constructor(onsuccess?: WssBridgeRequestCallback, onerror?: WssBridgeRequestCallback, context?: any, params?: any[]) {
        this.time = Date.now();
        this.onsuccess = onsuccess;
        this.onerror = onerror;
        this.context = context || this;
        this.params = params;
    }
    public callSuccess(resp: WssBridgeResponse) {
        if (this.onsuccess) {
            this.onsuccess.call(this.context, resp, this.params);
        }
    }
    public callError(resp: WssBridgeResponse) {
        if (this.onerror) {
            this.onerror.call(this.context, resp, this.params);
        }
    }
}
export class WssBridgeResponse {
    public code: number;//状态码
    public data: any;//正确数据或错误描述
    public constructor(code: number, data: any) {
        this.code = code;
        this.data = data;
    }
    public get ok(): boolean { return this.code === 200; }
}
export class WssBridge {
    public static readonly LOG_LEVEL_ALL = 1;
    public static readonly LOG_LEVEL_DATA = 2;
    public static readonly LOG_LEVEL_INFO = 3;
    public static readonly LOG_LEVEL_NONE = 4;
    private _host: string;//服务器地址
    private _pwd: string;//数据加解密密码
    private _binary: boolean;//是否用二进制传输
    private _timeout: number;//请求超时（毫秒）
    private _heartick: number;//心跳间隔（秒）
    private _conntick: number;//重连间隔（秒）
    private _timer: any;//秒钟计时器
    private _timerInc: number;//秒数自增量
    private _reqIdInc: number;//请求自增量
    private _netDelay: number;//网络延迟
    private _retryCnt: number;//断线重连尝试次数
    private _listeners: { [key: string]: WssBridgeListener[] };//监听集合
    private _requests: { [key: string]: WssBridgeRequest };//请求集合
    private _logLevel: number;//调试信息输出级别
    private _socket: WebSocket;//套接字
    private _paused: boolean;//是否暂停重连
    private _expired: boolean;//是否已经销毁
    //状态监听
    private _onopen: WssBridgeOnopen;
    private _onclose: WssBridgeOnclose;
    private _onerror: WssBridgeOnerror;
    private _onretry: WssBridgeOnretry;
    private _onsecond: WssBridgeOnsecond;
    private _context: any;
    private _params: any[];
    /**
     * @param host 服务器地址（http://、https://、ws://、wss://）
     * @param pwd 数据加解密密码
     * @param binary 是否用二进制传输
     * @param timeout 请求超时（毫秒）
     * @param heartick 心跳间隔（秒）
     * @param conntick 重连间隔（秒）
     */
    public constructor(host: string, pwd: string, binary: boolean, timeout: number = 8000, heartick: number = 60, conntick: number = 3) {
        this._host = host.indexOf('https:') === 0 ? host.replace('https:', 'wss:') : (host.indexOf('http:') === 0 ? host.replace('http:', 'ws:') : host);
        this._pwd = pwd;
        this._binary = binary;
        this._timeout = timeout;
        this._heartick = heartick;
        this._conntick = conntick;
        this._timer = null;
        this._timerInc = 0;
        this._reqIdInc = 0;
        this._netDelay = 0;
        this._retryCnt = 0;
        this._listeners = {};
        this._requests = {};
        this._logLevel = WssBridge.LOG_LEVEL_NONE;
        this._socket = null;
        this._paused = false;
        this._expired = false;
    }
    private onSocketOpen(e: any) {
        if (this._logLevel < WssBridge.LOG_LEVEL_NONE) console.log('connected', this._host);
        this._retryCnt = 0;//重置重连次数为0
        if (this._onopen) this._onopen.call(this._context, this._params);
    }
    private onSocketMessage(e: any): void {
        if (this._expired) return;
        this.readPackData(e.data);
    }
    private onSocketClose(e: any) {
        if (this._expired) return;
        this.safeClose(WssBridgePackData.CODE_CLOSE.code, WssBridgePackData.CODE_CLOSE.data);
        if (this._onclose) this._onclose.call(this._context, e.code || 0, e.reason || 'Unknow Reason', this._params);
    }
    private onSocketError(e: any) {
        if (this._expired) return;
        this.safeClose(WssBridgePackData.CODE_ERROR.code, WssBridgePackData.CODE_ERROR.data);
        if (this._onerror) this._onerror.call(this._context, e.message || 'Unknow Error', this._params);
    }
    private onTimerTick() {
        //秒数自增
        this._timerInc++;
        //清除超时的请求
        let time: number = Date.now();
        let list: string[] = [];
        for (let reqId in this._requests) {
            let request: WssBridgeRequest = this._requests[reqId];
            if (time - request.time > this._timeout) {
                request.callError(new WssBridgeResponse(504, 'Gateway Timeout'));
                list.push(reqId);
            }
        }
        for (let i = 0; i < list.length; i++) {
            delete this._requests[list[i]];
        }
        //心跳和断线重连
        if (this.isConnected()) {
            if (this._timerInc % this._heartick === 0) {
                this.sendPackData(new WssBridgePackData(WssBridgePackData.ROUTE_HEARTICK, this._reqIdInc++, Date.now()));//发送心跳包
            }
        } else {
            if (this._timerInc % this._conntick === 0 && !this._paused) {
                this._retryCnt++;//增加重连次数
                if (this._onretry) this._onretry.call(this._context, this._retryCnt, this._params);
                this.safeOpen();//安全开启连接
            }
        }
        //秒钟回调
        if (this._onsecond) {
            this._onsecond.call(this._context, this._timerInc, this._netDelay, this._params);
        }
    }
    private sendPackData(pack: WssBridgePackData) {
        if (this._expired) return;
        if (this.isConnected()) {
            let data = WssBridgePackData.serialize(pack, this._pwd, this._binary);
            if (!data) {
                if (this._onerror) this._onerror.call(this._context, 'Serialize Error', this._params);
                return;
            }
            this._socket.send(data);
            this.printPackData('sendPackData >>>', pack);
        }
    }
    private readPackData(data: any) {
        let pack = WssBridgePackData.deserialize(data, this._pwd);
        if (!pack) {
            if (this._onerror) this._onerror.call(this._context, 'Deserialize Error', this._params);
            return;
        }
        this.printPackData('readPackData <<<', pack);
        switch (pack.route) {
            case WssBridgePackData.ROUTE_HEARTICK:
                //服务端心跳响应
                this._netDelay = Date.now() - pack.message;//更新网络延迟
                if (this._logLevel === WssBridge.LOG_LEVEL_ALL) console.log('net delay:', this._netDelay + 'ms');
                break;
            case WssBridgePackData.ROUTE_RESPONSE:
                //客户端请求响应
                let request: WssBridgeRequest = this._requests[pack.reqId];
                if (!request) return;//超时的响应，监听器已经被_timer删除
                this._netDelay = Date.now() - request.time;//更新网络延迟
                if (this._logLevel === WssBridge.LOG_LEVEL_ALL) console.log('net delay:', this._netDelay + 'ms');
                let message = pack.message || {};
                let resp = new WssBridgeResponse(message.code, message.data);
                if (resp.code === 200) {
                    request.callSuccess(resp);
                } else {
                    request.callError(resp);
                }
                delete this._requests[pack.reqId];
                break;
            default:
                //服务器主动推送
                this.triggerEvent(pack);
                break;
        }
    }
    private printPackData(title: string, pack: WssBridgePackData) {
        if (pack.route === WssBridgePackData.ROUTE_HEARTICK) {
            if (this._logLevel === WssBridge.LOG_LEVEL_ALL) {
                console.group(title);
                console.log('route:', pack.route);
                if (pack.reqId !== undefined) console.log('reqId:', pack.reqId);
                if (pack.message !== undefined) console.log('message:', pack.message);
                console.groupEnd();
            }
        } else if (this._logLevel <= WssBridge.LOG_LEVEL_DATA) {
            console.group(title);
            console.log('route:', pack.route);
            if (pack.reqId !== undefined) console.log('reqId:', pack.reqId);
            if (pack.message !== undefined) console.log('message:', pack.message);
            console.groupEnd();
        }
    }
    private safeOpen() {
        this.safeClose(WssBridgePackData.CODE_RETRY.code, WssBridgePackData.CODE_RETRY.data);//关闭旧连接
        if (this._expired) return;
        /**
         * 经测试JS版本不管是浏览器还是服务端，CONNECTING与OPEN状态都可以直接调用close函数，最终都会为CLOSED
         * 建立新实例之前可以完美的销毁旧实例，所以无需加锁
         * 0 CONNECTING - The connection is not yet open.
         * 1 OPEN - The connection is open and ready to communicate.
         * 2 CLOSING - The connection is in the process of closing.
         * 3 CLOSED- The connection is closed.
         */
        this._socket = new WebSocket(this._host, typeof module === 'object' ? { rejectUnauthorized: false } : undefined);//创建WebSocket对象
        this._socket.binaryType = 'arraybuffer';
        this._socket.onopen = (e) => { this.onSocketOpen(e) };//添加连接打开侦听，连接成功会调用此方法
        this._socket.onmessage = (e) => { this.onSocketMessage(e) };//添加收到数据侦听，收到数据会调用此方法
        this._socket.onclose = (e) => { this.onSocketClose(e) };//添加连接关闭侦听，手动关闭或者服务器关闭连接会调用此方法
        this._socket.onerror = (e) => { this.onSocketError(e) };//添加异常侦听，出现异常会调用此方法
    }
    private safeClose(code: number, reason: string) {
        if (this._socket) {
            this._socket.close(code, reason);
            this._socket = null;
        }
    }
    /**
     * 开始进行网络连接
     * @param onopen 网络连接建立时的回调
     * @param onclose 网络连接关闭时的回调（包括手动关闭、服务端关闭等情况）
     * @param onerror 网络连接发生错误时的回调
     * @param onretry 网络连接断开，自动重连时的回调
     * @param onsecond 此函数每秒回调一次，回调参数中包含网络延迟等信息
     * @param context 触发回调函数时的绑定的上下文信息
     * @param params 触发回调函数时会传回这个参数
     */
    public connect(onopen: WssBridgeOnopen, onclose: WssBridgeOnclose, onerror: WssBridgeOnerror, onretry: WssBridgeOnretry, onsecond: WssBridgeOnsecond, context?: any, params?: any[]) {
        this._onopen = onopen;
        this._onclose = onclose;
        this._onerror = onerror;
        this._onretry = onretry;
        this._onsecond = onsecond;
        this._context = context || this;
        this._params = params;
        //打开
        this.safeOpen();//安全开启连接
        this._timer = setInterval(() => { this.onTimerTick() }, 1000);
    }
    /**
     * 强制关闭网络连接，并销毁这个实例
     * 注意：调用此函数后，此实例不可继续做网络操作，不可重新连接网络。
     */
    public disconnect() {
        if (this._logLevel < WssBridge.LOG_LEVEL_NONE) console.log('disconnected', this._host);
        this._expired = true;
        //关闭
        if (this._timer) {
            clearInterval(this._timer);
            this._timer = null;
        }
        this.safeClose(WssBridgePackData.CODE_CALL.code, WssBridgePackData.CODE_CALL.data);//安全关闭连接
    }
    /**
     * 向远程服务器发起请求
     * @param route 远程服务器路由地址
     * @param message 数据包
     * @param onsuccess 请求成功的回调
     * @param onerror 请求失败的回调
     * @param context 触发回调函数时的绑定的上下文信息
     * @param params 触发回调函数时会传回这个参数
     */
    public request(route: string, message: any, onsuccess?: WssBridgeRequestCallback, onerror?: WssBridgeRequestCallback, context?: any, params?: any[]) {
        let reqId = this._reqIdInc++;
        if (onsuccess || onerror) this._requests[reqId] = new WssBridgeRequest(onsuccess, onerror, context, params);//有监听器的放入请求队列
        this.sendPackData(new WssBridgePackData(route, reqId, message));
    }
    /**
     * 添加指定route的监听器，可用作自由定义事件的管理器
     * @param route 网络路由名称、本地自定义事件名称
     * @param once 是否触发一次后，自动删除此路由
     * @param onmessage 触发时的回调
     * @param context 触发回调函数时的绑定的上下文信息
     * @param params 触发回调函数时会传回这个参数
     */
    public addListener(route: string, once: boolean, onmessage: WssBridgeListenerCallback, context?: any, params?: any[]) {
        let listeners: WssBridgeListener[] = this._listeners[route];
        if (listeners === undefined) {
            listeners = [];
            this._listeners[route] = listeners;
        }
        listeners.push(new WssBridgeListener(once, onmessage, context, params));
    }
    /**
     * 删除指定route的监听器
     * @param route 网络路由名称、本地自定义事件名称
     * @param onmessage 要删除的监听器。不传这个参数则删除route对应的全部路由
     */
    public removeListener(route: string, onmessage?: WssBridgeListenerCallback) {
        let listeners: WssBridgeListener[] = this._listeners[route];
        if (!listeners) return;
        if (onmessage === undefined) {
            delete this._listeners[route];//删除该路由的全部监听
        } else {
            let list: WssBridgeListener[] = [];
            for (let i = 0; i < listeners.length; i++) {
                let item = listeners[i];
                if (item.onmessage === onmessage) {
                    list.push(item);
                }
            }
            while (list.length > 0) {
                let index = listeners.indexOf(list.pop());
                if (index >= 0) {
                    listeners.splice(index, 1);
                }
            }
            if (listeners.length === 0) {
                delete this._listeners[route];
            }
        }
    }
    /**
     * 手动触发pack.route对应的全部监听器
     * @param pack 路由包装实例
     */
    public triggerEvent(pack: WssBridgePackData) {
        let listeners: WssBridgeListener[] = this._listeners[pack.route];
        if (!listeners) return;
        let oncelist: WssBridgeListener[] = [];//删除只触发一次的监听
        for (let i = 0; i < listeners.length; i++) {
            let item = listeners[i];
            item.callMessage(pack.message);
            if (item.once) {
                oncelist.push(item);
            }
        }
        for (let i = 0; i < oncelist.length; i++) {
            this.removeListener(pack.route, oncelist[i].onmessage);
        }
    }
    /**
     * 暂停断线自动重连的功能
     */
    public pauseReconnect() { this._paused = true; }
    /**
     * 恢复断线自动重连的功能
     */
    public resumeReconnect() { this._paused = false; }
    public setLogLevel(level: number) { this._logLevel = level; }
    public getNetDelay(): number { return this._netDelay; }
    public isConnected(): boolean { return this._socket && this._socket.readyState === WebSocket.OPEN; }
}