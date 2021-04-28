/**
 * 对ws封装的类
 * ws相关信息：https://github.com/websockets/ws
 */
import { v1 as uuid } from 'uuid';
import WebSocket from 'ws';
import https from 'https';
import http from 'http';
import { WssUIDLike, WssSession } from './WssSession';
import { WssBridge, WssBridgePackData, WssBridgeResponse } from '../client/AllExport';
import type { Logger } from 'log4js';
import type { EnvContext } from './EnvContext';

export interface WssServerConfig {
    pwd?: string;//数据加密密码，null不启用加密
    secret?: string;//内部推送数据包签名验签密钥
    binary?: boolean;//true使用二进制收发数据，false使用字符串收发数据
    cycle?: number;//心跳检测周期 ms
    timeout?: number;//两个心跳包之间的最大间隔时间 ms
    reqIdCache?: number;//校验重复包的包ID缓存数量 ms
}

export class WssServer {
    private _context: EnvContext;
    private _config: WssServerConfig;
    private _logger: Logger;
    private _wsscfg: WebSocket.ServerOptions;
    private _wssapp: WebSocket.Server;
    private _server: http.Server | https.Server;
    private _routerMap: { [key: string]: RouterListener };//路由监听集合
    private _remoteMap: { [key: string]: RemoteListener };//远程监听集合
    private _socketMap: { [key: string]: WssSession };//全部session集合，包括未绑定uid的session。（每个websocket连接对应一个session）
    private _sessionMap: { [key: string]: WssSession };//已绑定uid的session集合
    private _channelMap: { [key: string]: GroupChannel };//自定义消息推送组（如：聊天室、游戏房间等）
    private _clusterMap: { [key: string]: ClusterNode[] };//集群节点分组列表集合
    private _totalSocket: number;
    private _totalSession: number;
    private _cycleTicker: NodeJS.Timeout;
    private _serverCyclerListener: ServerCyclerListener;//心跳循环每次运行时的都会通知这个监听器
    private _sessionCloseListener: SessionCloseListener;//session关闭时的监听器，包括未绑定uid的session
    /**
     * @param context 上下文包装类实例
     * @param category 日志分类
     * @param config 配置信息
     * @param wsscfg 库ws配置信息，参考依赖库 https://github.com/websockets/ws
     * 
     * 本类将过滤掉wsscfg.host参数和wsscfg.port参数，请通过context来传入
     */
    constructor(context: EnvContext, category: string, config: WssServerConfig = {}, wsscfg: WebSocket.ServerOptions = {}) {
        this._context = context;
        this._config = {
            pwd: null,
            secret: null,
            binary: false,
            cycle: 60 * 1000,
            timeout: 60 * 1000 * 3,
            reqIdCache: 32
        };
        Object.assign(this._config, config);//拷贝配置信息
        //绑定log4js实例
        this._logger = context.getLogger(category);
        //处理wsscfg
        if (wsscfg.host) this._logger.warn('ingore wsscfg.host');
        delete wsscfg.host;
        if (wsscfg.port) this._logger.warn('ingore wsscfg.port');
        delete wsscfg.port;
        if (wsscfg.noServer) this._logger.warn('ingore wsscfg.noServer');
        delete wsscfg.noServer;
        this._wsscfg = wsscfg.server ? {} : { server: context.ssls ? https.createServer(context.readSSLKerCert()) : http.createServer() };
        Object.assign(this._wsscfg, wsscfg);//拷贝ws配置信息
        //绑定app和server
        this._wssapp = new WebSocket.Server(this._wsscfg);//创建ws应用实例
        this._server = this._wsscfg.server;//绑定HTTP/S服务器实例
        //其它属性
        this._routerMap = {};
        this._remoteMap = {};
        this._socketMap = {};
        this._sessionMap = {};
        this._channelMap = {};
        this._clusterMap = {};
        this._totalSocket = 0;
        this._totalSession = 0;
        this._cycleTicker = null;//定时器
        this._serverCyclerListener = null;
        this._sessionCloseListener = null;
    }
    /**
     * 初始化集群
     */
    public initClusters() {
        const heartick = Math.floor(this._config.cycle / 1000);
        for (let i = 0; i < this._context.links.length; i++) {
            const appName = this._context.links[i];
            const address = this._context.nodes[appName];
            const cluster = [];
            for (let k = 0; k < address.length; k++) {
                const url = (address[k].ssls ? 'wss://' : 'ws://') + (address[k].inip || address[k].host) + ':' + address[k].port;
                cluster.push({
                    grp: appName,//节点分组
                    url: url,//连接地址
                    rmc: new WssBridge(url, this._config.pwd, this._config.binary, 8000, heartick, 2),//远程客户端
                });
            }
            if (cluster.length > 0) {
                this._clusterMap[appName] = cluster;
            }
        }
    }
    /**
     * 设置周期监听器
     * @param serverCyclerListener 
     * @param sessionCloseListener 
     */
    public setListeners(serverCyclerListener: ServerCyclerListener, sessionCloseListener: SessionCloseListener) {
        this._serverCyclerListener = serverCyclerListener;
        this._sessionCloseListener = sessionCloseListener;
    }
    /**
     * 设置路由监听器
     * @param route 
     * @param listener 
     */
    public setRouter(route: string, listener: RouterListener) {
        this._routerMap[route] = listener;
    }
    /**
     * 设置远程监听器
     * @param route 
     * @param listener 
     */
    public setRemote(route: string, listener: RemoteListener) {
        this._remoteMap[route] = listener;
    }
    /**
     * 绑定uid到session
     * @param session 
     * @param uid 
     * @param closeold 
     */
    public bindUid(session: WssSession, uid: WssUIDLike, closeold: boolean = false) {
        //旧session处理
        const sessionold = this._sessionMap[uid.toString()];
        if (sessionold) {
            this.unbindUid(sessionold);//解绑uid对应的旧session（此步骤务必在close之前执行，否则close事件中，会将uid对应的新session移除掉）
            if (closeold) sessionold.close(RouteCode.CODE_NEWBIND.code, RouteCode.CODE_NEWBIND.data);//关闭旧的session
        }
        //新session处理
        this.unbindUid(session);//新session解绑旧的uid
        session.bindUid(uid);//新session绑定新的的uid
        this._sessionMap[uid.toString()] = session;//新session绑定到_sessionMap
        this._logger.debug('bindUid:', session.ip, session.id, session.uid);
    };
    /**
     * 解绑session的uid
     * @param session 
     */
    public unbindUid(session: WssSession) {
        if (!session.isBinded()) return;
        this._logger.debug('unbindUid:', session.ip, session.id, session.uid);
        delete this._sessionMap[session.uid.toString()];//从_sessionMap中移除
        session.unbindUid();
    }
    /**
     * 根据uid从本节点获取session
     * @param uid 
     */
    public getSession(uid: WssUIDLike): WssSession {
        return this._sessionMap[uid.toString()];
    }
    /**
     * 加入本节点的某个消息推送组
     * @param session 
     * @param gid 
     */
    public joinChannel(session: WssSession, gid: WssUIDLike) {
        const channel = this._channelMap[gid.toString()] || { count: 0, sessions: {} };
        if (!channel.sessions[session.id]) {
            channel.sessions[session.id] = session;
            channel.count++;
            session.joinChannel(gid);
        }
        this._channelMap[gid.toString()] = channel;
        this._logger.debug('joinChannel:', session.ip, session.id, session.uid, gid);
    }
    /**
     * 退出本节点的某个消息推送组
     * @param session 
     * @param gid 
     */
    public quitChannel(session: WssSession, gid: WssUIDLike) {
        const channel = this._channelMap[gid.toString()];
        if (!channel) return;
        if (channel.sessions[session.id]) {
            delete channel.sessions[session.id];
            channel.count--;
            session.quitChannel(gid);
        }
        if (channel.count <= 0) delete this._channelMap[gid.toString()];
        this._logger.debug('quitChannel:', session.ip, session.id, session.uid, gid);
    }
    /**
     * 删除本节点的某个消息推送组
     * @param gid 
     */
    public deleteChannel(gid: WssUIDLike) {
        const channel = this._channelMap[gid.toString()];
        if (!channel) return;
        for (let id in channel.sessions) {
            if (channel.sessions.hasOwnProperty(id)) {
                channel.sessions[id].quitChannel(gid);
            }
        }
        delete this._channelMap[gid.toString()];
        this._logger.debug('deleteChannel:', gid);
    }
    /**
     * 响应本节点的某个session的请求
     * @param session 
     * @param reqPack 
     * @param message 
     */
    public response(session: WssSession, reqPack: WssBridgePackData, message: WssBridgeResponse) {
        const pack = new WssBridgePackData(RouteCode.ROUTE_RESPONSE, reqPack.reqId, message);
        const data = WssBridgePackData.serialize(pack, this._config.pwd, this._config.binary);
        session.send(data, this._getSendOptions());
        this._logger.debug('response:', session.ip, session.id, session.uid, pack);
    }
    /**
     * 推送消息到本节点的某个session
     * @param uid 
     * @param route 
     * @param message 
     */
    public pushSession(uid: WssUIDLike, route: string, message: any) {
        const session = this._sessionMap[uid.toString()];
        if (!session) return;
        const pack = new WssBridgePackData(route, undefined, message);
        const data = WssBridgePackData.serialize(pack, this._config.pwd, this._config.binary);
        session.send(data, this._getSendOptions());
        this._logger.debug('pushSession:', session.ip, session.id, session.uid, pack);
    }
    /**
     * 推送消息到本节点的某批session
     * @param uids 
     * @param route 
     * @param message 
     */
    public pushSessionBatch(uids: WssUIDLike[], route: string, message: any) {
        const pack = new WssBridgePackData(route, undefined, message);
        const data = WssBridgePackData.serialize(pack, this._config.pwd, this._config.binary);
        for (let i = 0; i < uids.length; i++) {
            const session = this._sessionMap[uids[i].toString()];
            if (session) {
                session.send(data, this._getSendOptions());
            }
        }
        this._logger.debug('pushSessionBatch:', uids, pack);
    }
    /**
     * 推送消息到本节点的某个消息推送组
     * @param gid 
     * @param route 
     * @param message 
     */
    public pushChannel(gid: WssUIDLike, route: string, message: any) {
        const channel = this._channelMap[gid.toString()];
        if (!channel) return;
        const pack = new WssBridgePackData(route, undefined, message);
        const data = WssBridgePackData.serialize(pack, this._config.pwd, this._config.binary);
        for (let id in channel.sessions) {
            if (channel.sessions.hasOwnProperty(id)) {
                const session = channel.sessions[id];
                session.send(data, this._getSendOptions());
            }
        }
        this._logger.debug('pushChannel:', gid, pack);
    }
    /**
     * 推送消息到本节点的某个消息推送组，每个成员的数据都进过差异处理
     * @param gid 
     * @param route 
     * @param message 
     * @param customCallback 在这个函数中对每个成员的数据进行差异处理
     */
    public pushChannelCustom(gid: WssUIDLike, route: string, message: any, customCallback: PushChannelCustomCallback) {
        const channel = this._channelMap[gid.toString()];
        if (!channel) return;
        for (let id in channel.sessions) {
            if (channel.sessions.hasOwnProperty(id)) {
                const session = channel.sessions[id];
                const pack = new WssBridgePackData(route, undefined, customCallback(session.uid, message));
                const data = WssBridgePackData.serialize(pack, this._config.pwd, this._config.binary);
                session.send(data, this._getSendOptions());
                this._logger.debug('pushChannelCustom:', session.ip, session.id, session.uid, gid, pack);
            }
        }
    }
    /**
     * 推送消息到本节点的已经绑定过uid的全部session
     * @param route 
     * @param message 
     */
    public broadcast(route: string, message: any) {
        const pack = new WssBridgePackData(route, undefined, message);
        const data = WssBridgePackData.serialize(pack, this._config.pwd, this._config.binary);
        for (let uid in this._sessionMap) {
            if (this._sessionMap.hasOwnProperty(uid)) {
                const session = this._sessionMap[uid];
                session.send(data, this._getSendOptions());
            }
        }
        this._logger.debug('broadcast:', pack);
    }
    /**
     * 推送消息到某个节点的某个session，建议通过dispatchCallback来优化推送性能
     * @param appName 节点分组名
     * @param uid 
     * @param route 
     * @param message 
     * @param dispatchCallback 分配节点，如果未指定该函数，则从该节点分组的全部节点中搜索对应uid的session
     */
    public pushClusterSession(appName: string, uid: WssUIDLike, route: string, message: any, dispatchCallback?: ClusterDispatchCallback) {
        const cluster = this._clusterMap[appName];
        const innerData = this._generateInnerData(uid, route, message);
        if (dispatchCallback) {
            const handle = cluster[dispatchCallback(cluster, uid, innerData)];
            handle.rmc.request(RouteCode.ROUTE_INNERP2P, innerData);
            this._logger.debug('pushClusterSession:', appName, handle.url, innerData);
        } else {
            for (let i = 0; i < cluster.length; i++) {
                const handle = cluster[i];
                handle.rmc.request(RouteCode.ROUTE_INNERP2P, innerData);
                this._logger.debug('pushClusterSession:', appName, handle.url, innerData);
            }
        }
    }
    /**
     * 推送消息到某个节点的某个消息推送组，建议通过dispatchCallback来优化推送性能
     * @param appName 节点分组名
     * @param gid 
     * @param route 
     * @param message 
     * @param dispatchCallback 分配节点，如果未指定该函数，则从该节点分组的全部节点中搜索对应gid的channel
     */
    public pushClusterChannel(appName: string, gid: WssUIDLike, route: string, message: any, dispatchCallback?: ClusterDispatchCallback) {
        const cluster = this._clusterMap[appName];
        const innerData = this._generateInnerData(gid, route, message);
        if (dispatchCallback) {
            const handle = cluster[dispatchCallback(cluster, gid, innerData)];
            handle.rmc.request(RouteCode.ROUTE_INNERGRP, innerData);
            this._logger.debug('pushClusterChannel:', appName, handle.url, innerData);
        } else {
            for (let i = 0; i < cluster.length; i++) {
                const handle = cluster[i];
                handle.rmc.request(RouteCode.ROUTE_INNERGRP, innerData);
                this._logger.debug('pushClusterChannel:', appName, handle.url, innerData);
            }
        }
    }
    /**
     * 推送消息到某个节点的已经绑定过uid的全部session
     * @param appName 节点分组名
     * @param route 
     * @param message 
     * @param dispatchCallback 分配节点，如果未指定该函数，将推送到该节点分组的全部节点
     */
    public clusterBroadcast(appName: string, route: string, message: any, dispatchCallback?: ClusterDispatchCallback) {
        const cluster = this._clusterMap[appName];
        const innerData = this._generateInnerData(null, route, message);
        if (dispatchCallback) {
            const handle = cluster[dispatchCallback(cluster, null, innerData)];
            handle.rmc.request(RouteCode.ROUTE_INNERALL, innerData);
            this._logger.debug('clusterBroadcast:', appName, handle.url, innerData);
        } else {
            for (let i = 0; i < cluster.length; i++) {
                const handle = cluster[i];
                handle.rmc.request(RouteCode.ROUTE_INNERALL, innerData);
                this._logger.debug('clusterBroadcast:', appName, handle.url, innerData);
            }
        }
    }
    /**
     * 节点间远程路由异步调用
     * @param appName 节点分组名
     * @param route 
     * @param message 
     * @param dispatchCallback 分配节点，如果未指定该函数，则从该节点分组的全部节点中随机选择一个节点
     */
    public callRemote(appName: string, route: string, message: any, dispatchCallback?: ClusterDispatchCallback) {
        const cluster = this._clusterMap[appName];
        const innerData = this._generateInnerData(null, route, message);
        const index = dispatchCallback ? dispatchCallback(cluster, null, innerData) : Math.min(Math.floor(Math.random() * cluster.length), cluster.length - 1);
        const handle = cluster[index];
        this._logger.debug('callRemote:', appName, handle.url, innerData);
        handle.rmc.request(RouteCode.ROUTE_INNERRMC, innerData);
    }
    /**
     * 节点间远程路由异步调用，并返回结果
     * @param appName 节点分组名
     * @param route 
     * @param message 
     * @param dispatchCallback 分配节点，如果未指定该函数，则从该节点分组的全部节点中随机选择一个节点
     */
    public callRemoteForResult(appName: string, route: string, message: any, dispatchCallback?: ClusterDispatchCallback): Promise<WssBridgeResponse> {
        const cluster = this._clusterMap[appName];
        const msgdata = this._generateInnerData(null, route, message);
        const index = dispatchCallback ? dispatchCallback(cluster, null, msgdata) : Math.min(Math.floor(Math.random() * cluster.length), cluster.length - 1);
        const handle = cluster[index];
        this._logger.debug('callRemoteForResult:', appName, handle.url, msgdata);
        return new Promise((resolve) => {
            handle.rmc.request(RouteCode.ROUTE_INNERRMC, msgdata, (resp, params) => {
                resolve(resp);
            }, (resp, params) => {
                resolve(resp);
            }, this);
        });
    }
    /**
     * 开启服务器
     * @param callback 服务器启动后的回调函数
     */
    public start(callback?: () => void) {
        //参数检测
        if (this._config.cycle < 10000) throw Error('cycle >= 10,000ms');
        if (this._config.timeout < 30000) throw Error('timeout >= 30,000ms');
        if (this._config.cycle * 3 > this._config.timeout) throw Error('timeout >= cycle * 3');
        //注册监听
        this._wssapp.on('connection', (socket, request) => {
            this._onWebSocketConnection(socket, request);
        });
        //开启心跳循环
        this._cycleTicker = setInterval(() => {
            try {
                this._onServerLifeCycle();
            } catch (e) {
                this._logger.error('Unhandled life cycle exception：', e);
            }
        }, this._config.cycle);
        //连接关联的集群节点
        for (let appName in this._clusterMap) {
            if (this._clusterMap.hasOwnProperty(appName)) {
                const cluster = this._clusterMap[appName];
                for (let i = 0; i < cluster.length; i++) {
                    this._connectForCluster(cluster[i]);
                }
            }
        }
        //启动服务器
        this._server.listen(this._context.port, () => {
            this._logger.info('ssls', this._context.ssls, this._context.host, this._context.port, 'is listening...');
            if (callback) callback();
        });
    }
    /**
     * 关闭服务器
     * @param callback 
     */
    public close(callback?: (error?: Error) => void) {
        //销毁心跳循环
        if (this._cycleTicker) {
            clearInterval(this._cycleTicker);
            this._cycleTicker = null;
        }
        //断开关联的集群节点
        for (let appName in this._clusterMap) {
            if (this._clusterMap.hasOwnProperty(appName)) {
                const cluster = this._clusterMap[appName];
                for (let i = 0; i < cluster.length; i++) {
                    cluster[i].rmc.disconnect();
                }
            }
        }
        //关闭服务器
        this._server.close((error) => {
            this._logger.info('ssls', this._context.ssls, this._context.host, this._context.port, 'was closed.');
            if (callback) callback(error);
        });
    }
    /**
     * 周期循环
     */
    private _onServerLifeCycle() {
        let totalSocket = 0;
        let totalSession = 0;
        for (let id in this._socketMap) {
            if (this._socketMap.hasOwnProperty(id)) {
                const session = this._socketMap[id];
                if (session.isExpired(this._config.timeout)) {
                    session.close(RouteCode.CODE_TIMEOUT.code, RouteCode.CODE_TIMEOUT.data);//清除超时的链接
                } else {
                    totalSocket += 1;
                    totalSession += session.isBinded() ? 1 : 0;
                }
            }
        }
        this._logger.info('_onServerLifeCycle:', 'totalSocket->', totalSocket, 'totalSession->', totalSession);
        //更新连接数量
        this._totalSocket = totalSocket;
        this._totalSession = totalSession;
        //回调上层绑定的监听器
        if (this._serverCyclerListener) {
            this._serverCyclerListener(this, this._totalSocket, this._totalSession);
        }
    }
    /**
     * 收到连接后注册监听
     * @param socket 
     * @param request 
     */
    private _onWebSocketConnection(socket: WebSocket, request: http.IncomingMessage) {
        const session = new WssSession(socket, this._context.getIPV4({ headers: request.headers, ip: request.connection.remoteAddress }));
        this._socketMap[session.id] = session;//绑定到_socketMap
        socket.binaryType = 'arraybuffer';//指定读取格式为arraybuffer
        socket.on('message', (data) => {
            this._onWebSocketMessage(session, data as (ArrayBuffer | string));
        });
        socket.on('close', (code, reason) => {
            this._logger.info('on websocket close:', session.ip, session.id, session.uid, code, reason);
            //回调上层绑定的监听器
            if (this._sessionCloseListener) {
                this._sessionCloseListener(this, session, code, reason);
            }
            //统一进行内存清理操作
            session.eachChannel((gid) => { this.quitChannel(session, gid) });//退出已加入的所有分组
            this.unbindUid(session);//可能已经绑定了uid，需要进行解绑操作
            delete this._socketMap[session.id];//从_socketMap中移除
        });
        socket.on('error', (error) => {
            this._logger.error('on websocket error:', session.ip, session.id, session.uid, error.toString());
            session.close(RouteCode.CODE_SOCKET.code, RouteCode.CODE_SOCKET.data + ': ' + error.toString());
        });
        this._logger.info('on websocket connection:', session.ip, session.id);
    }
    /**
     * 
     * @param session 
     * @param data 
     */
    private _onWebSocketMessage(session: WssSession, data: ArrayBuffer | string) {
        const pack = WssBridgePackData.deserialize(data, this._config.pwd);
        //解析包数据
        if (!pack) {
            this._logger.error('_onWebSocketMessage:', session.ip, session.id, session.uid, RouteCode.CODE_PARSE.code, data);
            session.close(RouteCode.CODE_PARSE.code, RouteCode.CODE_PARSE.data);
            return;
        }
        //校验包格式
        if (typeof pack.route !== 'string' || typeof pack.reqId !== 'number' || pack.message === undefined || pack.message === null) {
            this._logger.error('_onWebSocketMessage:', session.ip, session.id, session.uid, RouteCode.CODE_FORMAT.code, pack);
            session.close(RouteCode.CODE_FORMAT.code, RouteCode.CODE_FORMAT.data);
            return;
        }
        //校验重复包
        if (!session.updateReqId(pack.reqId, this._config.reqIdCache)) {
            this._logger.error('_onWebSocketMessage:', session.ip, session.id, session.uid, RouteCode.CODE_REPEAT.code, pack);
            session.close(RouteCode.CODE_REPEAT.code, RouteCode.CODE_REPEAT.data);
            return;
        }
        //收到心跳包
        if (pack.route === RouteCode.ROUTE_HEARTICK) {
            this._logger.trace('_onWebSocketMessage:', session.ip, session.id, session.uid, pack);
            session.updateHeart();//更新本次心跳时间戳
            this._sendHeartick(session, pack);//按照原样发回客户端
            return;
        }
        //集群P2P包
        if (pack.route === RouteCode.ROUTE_INNERP2P) {
            if (this._validateInnerData(pack.message)) {
                this._logger.debug('_onWebSocketMessage:', session.ip, session.id, session.uid, pack);
                this.pushSession(pack.message.tid, pack.message.route, pack.message.message);
            } else {
                this._logger.error('_onWebSocketMessage:', session.ip, session.id, session.uid, RouteCode.CODE_SIGN.code, pack);
                session.close(RouteCode.CODE_SIGN.code, RouteCode.CODE_SIGN.data);
            }
            return;
        }
        //集群GRP包
        if (pack.route === RouteCode.ROUTE_INNERGRP) {
            if (this._validateInnerData(pack.message)) {
                this._logger.debug('_onWebSocketMessage:', session.ip, session.id, session.uid, pack);
                this.pushChannel(pack.message.tid, pack.message.route, pack.message.message);
            } else {
                this._logger.error('_onWebSocketMessage:', session.ip, session.id, session.uid, RouteCode.CODE_SIGN.code, pack);
                session.close(RouteCode.CODE_SIGN.code, RouteCode.CODE_SIGN.data);
            }
            return;
        }
        //集群ALL包
        if (pack.route === RouteCode.ROUTE_INNERALL) {
            if (this._validateInnerData(pack.message)) {
                this._logger.debug('_onWebSocketMessage:', session.ip, session.id, session.uid, pack);
                this.broadcast(pack.message.route, pack.message.message);
            } else {
                this._logger.error('_onWebSocketMessage:', session.ip, session.id, session.uid, RouteCode.CODE_SIGN.code, pack);
                session.close(RouteCode.CODE_SIGN.code, RouteCode.CODE_SIGN.data);
            }
            return;
        }
        //集群RMC包
        if (pack.route === RouteCode.ROUTE_INNERRMC) {
            if (this._validateInnerData(pack.message)) {
                if (this._remoteMap[pack.message.route]) {
                    this._logger.debug('_onWebSocketMessage:', session.ip, session.id, session.uid, pack);
                    this._remoteMap[pack.message.route](this, session, new WssBridgePackData(pack.message.route, pack.reqId, pack.message.message));//调用远程方法
                } else {
                    this._logger.error('_onWebSocketMessage:', session.ip, session.id, session.uid, RouteCode.CODE_REMOTE.code, pack);
                    session.close(RouteCode.CODE_REMOTE.code, RouteCode.CODE_REMOTE.data);
                }
            } else {
                this._logger.error('_onWebSocketMessage:', session.ip, session.id, session.uid, RouteCode.CODE_SIGN.code, pack);
                session.close(RouteCode.CODE_SIGN.code, RouteCode.CODE_SIGN.data);
            }
            return;
        }
        //自定义路由
        if (this._routerMap[pack.route]) {
            this._logger.debug('_onWebSocketMessage:', session.ip, session.id, session.uid, pack);
            this._routerMap[pack.route](this, session, pack);//调用路由方法
            return;
        }
        //没找到路由
        this._logger.error('_onWebSocketMessage:', session.ip, session.id, session.uid, RouteCode.CODE_ROUTE.code, pack);
        session.close(RouteCode.CODE_ROUTE.code, RouteCode.CODE_ROUTE.data);
    }
    /**
     * 返回发送数据到客户端websocket的选项
     */
    private _getSendOptions(): { binary: boolean } {
        return { binary: this._config.binary };
    }
    /**
     * 响应心跳包
     * @param session 
     * @param reqPack 
     */
    private _sendHeartick(session: WssSession, reqPack: WssBridgePackData) {
        const pack = new WssBridgePackData(RouteCode.ROUTE_HEARTICK, reqPack.reqId, reqPack.message);
        const data = WssBridgePackData.serialize(pack, this._config.pwd, this._config.binary);
        session.send(data, this._getSendOptions());
        this._logger.trace('_sendHeartick:', session.ip, session.id, session.uid, pack);
    }
    /**
     * 连接到集群节点
     * @param node 
     */
    private _connectForCluster(node: ClusterNode) {
        node.rmc.setLogLevel(WssBridge.LOG_LEVEL_NONE);
        node.rmc.connect(() => {
            this._logger.mark('cluster onopen->', node.grp, node.url);
        }, (code, reason, params) => {
            // this._logger.warn('cluster onclose->', code, reason);
        }, (error, params) => {
            // this._logger.error('cluster onerror->', error);
        }, (count, params) => {
            this._logger.debug('cluster onretry->', node.grp, node.url, count, 'times');
        }, null, this);
    }
    /**
     * 生成内部签名数据包
     * @param tid 
     * @param route 
     * @param message 
     */
    private _generateInnerData(tid: WssUIDLike, route: string, message: any): InnerData {
        const data: InnerData = {};
        if (tid) data.tid = tid;
        data.route = route;
        data.message = message;
        data.word = uuid();
        data.sign = this._context.getMd5(route + data.word + this._config.secret);
        return data;
    }
    /**
     * 校验内部签名数据包
     * @param data 
     */
    private _validateInnerData(data: InnerData): boolean {
        return this._context.getMd5(data.route + data.word + this._config.secret) === data.sign;
    }
    /**
     * 返回Logger实例
     */
    public get logger() { return this._logger; }
    public get wssapp() { return this._wssapp; }
    public get server() { return this._server; }
    public get wssPwd() { return this._config.pwd; }
    public get wssSecret() { return this._config.secret; }
}
interface ServerCyclerListener { (server: WssServer, totalSocket: number, totalSession: number): void; }
interface SessionCloseListener { (server: WssServer, session: WssSession, code: number, reason: string): void; }
interface RouterListener { (server: WssServer, session: WssSession, pack: WssBridgePackData): void; }
interface RemoteListener { (server: WssServer, session: WssSession, pack: WssBridgePackData): void; }
interface PushChannelCustomCallback { (uid: WssUIDLike, message: any): any; }
interface ClusterDispatchCallback { (cluster: ClusterNode[], tid: WssUIDLike, innerData: InnerData): number; }
interface ClusterNode { grp: string; url: string; rmc: WssBridge; }
interface GroupChannel { count: number; sessions: { [key: string]: WssSession }; }
interface InnerData { tid?: WssUIDLike, route?: string; message?: any; word?: string; sign?: any; }
/**
 * 状态码范围参考： https://tools.ietf.org/html/rfc6455#section-7.4.2
 * 以及：https://github.com/websockets/ws/issues/715
 */
class RouteCode {
    /**
     * 路由
     */
    public static ROUTE_HEARTICK = '$heartick$';//心跳包路由
    public static ROUTE_RESPONSE = '$response$';//响应请求路由
    public static ROUTE_INNERP2P = '$innerP2P$';//集群点对点消息路由
    public static ROUTE_INNERGRP = '$innerGRP';//集群分组消息路由
    public static ROUTE_INNERALL = '$innerALL$';//集群广播消息路由
    public static ROUTE_INNERRMC = '$innerRMC$';//集群远程方法路由
    /**
     * 状态
     * 本框架保留状态码:
     * 4001-4100 服务端保留状态码范围
     * 4101-4200 客户端保留状态码范围
     * 4201-4999 可自定义的状态码范围
     */
    public static CODE_PARSE = { code: 4001, data: 'parse error' };
    public static CODE_FORMAT = { code: 4002, data: 'format error' };
    public static CODE_REPEAT = { code: 4003, data: 'repeat error' };
    public static CODE_SIGN = { code: 4004, data: 'sign error' };
    public static CODE_REMOTE = { code: 4005, data: 'remote error' };
    public static CODE_ROUTE = { code: 4006, data: 'route error' };
    public static CODE_SOCKET = { code: 4007, data: 'socket error' };
    public static CODE_TIMEOUT = { code: 4008, data: 'timeout error' };
    public static CODE_NEWBIND = { code: 4009, data: 'newbind error' };
}