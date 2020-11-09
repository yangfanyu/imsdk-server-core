/**
 * ws的WebSocket封装类
 * ws相关信息：https://github.com/websockets/ws
 */
import WebSocket from 'ws';
import type { ObjectId } from 'mongodb';

export interface WssUIDLike { toString(): string; }

export class WssSession {
    private static _increment: number = 1;
    private _id: number;//自增id
    private _socket: WebSocket;//绑定的套接字
    private _ip: string;//绑定的IP地址
    private _uid: WssUIDLike;//绑定的用户ID
    private _context: { [key: string]: any };//缓存的自定义数据
    private _channel: { [key: string]: boolean };//加入的自定义群组
    private _reqIdList: number[];//最近N个请求id（防止被重复ID的包攻击，其它类型的攻击请使用第三方安全模块）
    private _lastHeart: number;//初始化最近收到心跳包的时间为创建时间
    /**
     * @param socket 
     * @param ip 
     */
    public constructor(socket: WebSocket, ip: string) {
        this._id = WssSession._increment++;
        this._socket = socket;
        this._ip = ip;
        this._uid = null;
        this._context = {};
        this._channel = {};
        this._reqIdList = [];
        this._lastHeart = Date.now();
    }
    /**
     * 使用WebSocket发送数据
     * @param data 要发送的数据
     * @param options 具体属性参考依赖库 https://github.com/expressjs/multer
     * @param cb 发送后的回调
     */
    public send(data: any, options?: { mask?: boolean; binary?: boolean; compress?: boolean; fin?: boolean }, cb?: (error?: Error) => void): boolean {
        if (this._socket && this._socket.readyState === WebSocket.OPEN) {
            this._socket.send(data, options, cb);
            return true;
        } else {
            return false;
        }
    }
    /**
     * 关闭WebSocket
     * 本框架保留状态码:
     * 4001-4100 服务端保留状态码范围
     * 4101-4200 客户端保留状态码范围
     * 4201-4999 可自定义的状态码范围
     * 更多状态码资料参考： https://tools.ietf.org/html/rfc6455#section-7.4.2 和 https://github.com/websockets/ws/issues/715
     * @param code 
     * @param reason 
     */
    public close(code: number, reason: string) {
        if (this._socket) {
            this._socket.close(code, reason);
            this._socket = null;
        }
    }
    /**
     * 绑定用户ID
     * @param uid 
     */
    public bindUid(uid: WssUIDLike) {
        this._uid = uid;
    }
    /**
     * 解绑用户ID
     */
    public unbindUid() {
        this._uid = null;
    }
    /**
     * 缓存键值对数据
     * @param key 
     * @param value 
     */
    public setContext(key: string, value: any) {
        this._context[key] = value;
    }
    /**
     * 读取键值对数据
     * @param key 
     */
    public getContext(key: string): any {
        return this._context[key];
    }
    /**
     * 删除键值对数据
     * @param key 
     */
    public delContext(key: string) {
        delete this._context[key];
    }
    /**
     * 加入指定推送组
     * @param gid 
     */
    public joinChannel(gid: WssUIDLike) {
        this._channel[gid.toString()] = true;
    }
    /**
     * 退出指定推送组
     * @param gid 
     */
    public quitChannel(gid: WssUIDLike) {
        delete this._channel[gid.toString()];
    }
    /**
     * 遍历已加入的全部推送组
     * @param callback 
     */
    public eachChannel(callback: (gid: WssUIDLike) => void) {
        for (let gid in this._channel) {
            if (this._channel.hasOwnProperty(gid)) callback(gid);
        }
    }
    /**
     * 更新流量统计信息，同时返回是否收到重复包
     * @param reqId 请求id
     * @param cacheSize 缓存reqId数量上限
     */
    public updateReqId(reqId: number, cacheSize: number): boolean {
        if (this._reqIdList.lastIndexOf(reqId) >= 0) {
            return false;//收到重复包
        } else {
            if (this._reqIdList.length >= cacheSize) {
                this._reqIdList.splice(0, Math.floor(cacheSize / 2));//清掉队列前的一半缓存
            }
            this._reqIdList.push(reqId);
            return true;
        }
    }
    /**
     * 更新最近收到心跳包的时间
     */
    public updateHeart() {
        this._lastHeart = Date.now();
    }
    /**
     * 是否绑定了UID
     */
    public isBinded(): boolean {
        return !!this._uid;
    }
    /**
     * 是否已经超时未收到心跳包
     * @param timeout 
     */
    public isExpired(timeout: number) {
        return Date.now() > this._lastHeart + timeout;
    }
    public get id() { return this._id; }
    public get ip() { return this._ip; }
    public get uid() { return this._uid; }
    public get ouid() { return <ObjectId>this._uid; }
}