/**
 * 运行环境工具类
 * lo4js相关信息：https://log4js-node.github.io/log4js-node/
 * 自定义证书生成:
 * openssl genrsa -out localhost.key 2048
 * openssl req -new -sha256 -key localhost.key -out localhost.csr
 * openssl x509 -req -in localhost.csr -signkey localhost.key -out localhost.pem
 */
import fs from 'fs';
import path from 'path';
import log4js from 'log4js';
import CryptoJS from 'crypto-js';
import type { IncomingHttpHeaders } from 'http';

export class EnvContext {
    private _appDir: string;//节点启动时指定的一个根目录绝对路径
    private _appEnv: string;//节点启动环境类型，如: development、production1、production2、production3...
    private _appName: string;//节点类型名称，如 http、home、chat...
    private _appHost: string;//节点所在主机名
    private _appInIP: string;//节点所在主机内网IP
    private _appPort: number;//节点所监听的端口号
    private _appSSLs: { key: string, cert: string };//节点SSL证书路径
    private _appLinks: string[];//本节点需要连接的其它节点类型名称
    private _appNodes: { [key: string]: { host: string, inip: string, port: number, ssls: boolean }[] };//全部的节点
    private _encode: BufferEncoding;//编码默认值为utf8
    private _logcfgs: log4js.Configuration;//log4js的配置文件信息
    private _context: { [key: string]: any };//键值对缓存
    /**
     * @param appDir 节点启动时指定的一个根目录绝对路径
     * @param appEnv 节点启动环境类型，如: development、production1、production2、production3...
     * @param appName 节点类型名称，如 http、home、chat...
     * @param appHost 节点所在主机名
     * @param appInIP 节点所在主机内网IP
     * @param appPort 节点所监听的端口号
     * @param appSSLs 节点SSL证书路径
     * @param appLinks 本节点需要连接的其它节点类型名称
     * @param appNodes 全部的节点
     * @param encode 编码默认值为utf8
     */
    public constructor(appDir: string, appEnv: string, appName: string, appHost: string, appInIP: string, appPort: number | string, appSSLs?: { key: string, cert: string }, appLinks?: string[], appNodes?: { [key: string]: { host: string, inip: string, port: number, ssls: boolean }[] }, encode: BufferEncoding = 'utf8') {
        this._appDir = appDir;
        this._appEnv = appEnv;
        this._appName = appName;
        this._appHost = appHost;
        this._appInIP = appInIP;
        this._appPort = Number(appPort);
        this._appSSLs = appSSLs;
        this._appLinks = appLinks;
        this._appNodes = appNodes;
        this._encode = encode;
        this._logcfgs = null;
        this._context = {};
    }
    /**
     * 加载对应_envName的log4js配置信息，并初始化log4js
     * @param configs log4js配置的文件绝对路径 或 log4js配置的数据内容
     */
    public initLog4js(configs: string | { [key: string]: log4js.Configuration }) {
        let logStr = typeof configs === 'string' ? fs.readFileSync(configs, { encoding: this._encode }) : JSON.stringify(configs);
        logStr = logStr.replace(new RegExp('\\${opt:appDir}', 'gm'), this._appDir);
        logStr = logStr.replace(new RegExp('\\${opt:appEnv}', 'gm'), this._appEnv);
        logStr = logStr.replace(new RegExp('\\${opt:appName}', 'gm'), this._appName);
        logStr = logStr.replace(new RegExp('\\${opt:appHost}', 'gm'), this._appHost);
        logStr = logStr.replace(new RegExp('\\${opt:appPort}', 'gm'), String(this._appPort));
        this._logcfgs = JSON.parse(logStr)[this._appEnv];
        log4js.configure(this._logcfgs);
    }
    /**
     * 加载对应_envName的自定义配置信息
     * @param configs 自定义配置的文件绝对路径 或 自定义配置的数据内容
     */
    public loadConfig<T>(configs: string | { [key: string]: T }): T {
        if (typeof configs === 'string') {
            const cfgStr = fs.readFileSync(configs, { encoding: this._encode });
            return JSON.parse(cfgStr)[this._appEnv];
        } else {
            return configs[this._appEnv];
        }
    }
    /**
     * 指定环境、指定进程进行定制化回掉
     * @param appEnv 指定进程启动环境类型，支持多个环境，如：development|production
     * @param appName 指定进程类型，支持多个名称，如：gate|home|chat，传null表示全部环境
     * @param callback 在这个回调函数里面定制自己的逻辑
     */
    public configure(appEnv: string, appName: string, callback: () => void) {
        const envArr = appEnv.split('|');
        if (envArr.indexOf(this._appEnv) >= 0) {
            if (appName) {
                const appArr = appName.split('|');
                if (appArr.indexOf(this._appName) >= 0) {
                    callback();
                }
            } else {
                callback();
            }
        }
    }
    /**
     * 获取一个log4js实例
     * @param category log4js的category
     */
    public getLogger(category: string): log4js.Logger {
        if (!this._logcfgs) throw Error('log4js configuration not specified');
        const logger = log4js.getLogger(category);
        logger.addContext('env', this._appEnv);
        logger.addContext('name', this._appName);
        logger.addContext('host', this._appHost);
        logger.addContext('port', this._appPort);
        return logger;
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
     * 创建多级文件夹
     * @param dirname 文件夹路径
     */
    public mkdirsSync(dirname: string): boolean {
        if (fs.existsSync(dirname)) {
            return true;
        } else {
            if (this.mkdirsSync(path.dirname(dirname))) {
                try {
                    fs.mkdirSync(dirname);
                    return true;
                } catch (e) {
                    return false;
                }
            } else {
                return false;
            }
        }
    }
    /**
     * 获取IPV4地址
     * @param request http请求
     * @param headerField 代理服务器的请求头字段名称
     */
    public getIPV4(request: { headers: IncomingHttpHeaders, ip: string }, headerField?: string): string {
        let ip = (request.headers ? request.headers[headerField || 'x-forwarded-for'] : null) || request.ip;
        if (!ip || '::1' === ip) ip = '127.0.0.1';
        if (Array.isArray(ip)) ip = ip.join(',');
        ip = ip.replace(/[:f]/gm, '');
        ip = ip.split(/\s*,\s*/)[0];
        ip = ip.trim() || '127.0.0.1';
        return ip;
    }
    /**
     * 格式化日期
     * @param date
     * @param fmt 
     */
    public formatDate(date: Date, fmt: string): string {
        const o: any = {
            "M+": date.getMonth() + 1, //月份
            "d+": date.getDate(), //日
            "H+": date.getHours(), //小时
            "m+": date.getMinutes(), //分
            "s+": date.getSeconds(), //秒
            "q+": Math.floor((date.getMonth() + 3) / 3), //季度
            "S": date.getMilliseconds() //毫秒
        };
        if (/(y+)/.test(fmt)) fmt = fmt.replace(RegExp.$1, (date.getFullYear() + "").substr(4 - RegExp.$1.length));
        for (let k in o) {
            if (new RegExp("(" + k + ")").test(fmt)) fmt = fmt.replace(RegExp.$1, (RegExp.$1.length === 1) ? (o[k]) : (("00" + o[k]).substr(("" + o[k]).length)));
        }
        return fmt;
    }
    /**
     * 计算md5
     * @param data 要计算编码的字符串
     */
    public getMd5(data: string): string {
        return CryptoJS.MD5(data).toString();
    }
    /**
     * 读取ssl证书并返回
     */
    public readSSLKerCert(): { key: string, cert: string } {
        return {
            key: fs.readFileSync(this._appSSLs.key, { encoding: this._encode }),
            cert: fs.readFileSync(this._appSSLs.cert, { encoding: this._encode })
        };
    }
    /**
     * 判断一个对象是否为空
     * @param obj 
     */
    public isEmptyObject(obj: any): boolean {
        for (let key in obj) {
            if (obj.hasOwnProperty(key)) return false;
        }
        return true;
    }
    /**
     * 模拟休眠
     * @param time 毫秒
     */
    public sleep(time: number): Promise<void> {
        return new Promise((resolve) => {
            setTimeout(() => {
                resolve();
            }, time);
        });
    }
    public get dir() { return this._appDir; }
    public get env() { return this._appEnv; }
    public get name() { return this._appName; }
    public get host() { return this._appHost; }
    public get inip() { return this._appInIP; }
    public get port() { return this._appPort; }
    public get ssls() { return !!this._appSSLs; }
    public get links() { return this._appLinks; }
    public get nodes() { return this._appNodes; }
    public get encode() { return this._encode; }
    /**
     * 根据环境变量创建上下文实例
     * @param processEnv 
     * @param encode 
     */
    public static createByProcessEnv(processEnv: any, encode: BufferEncoding = 'utf8') {
        return new EnvContext(
            processEnv.MYAPP_DIR,
            processEnv.MYAPP_ENV,
            processEnv.MYAPP_NAME,
            processEnv.MYAPP_HOST,
            processEnv.MYAPP_INIP,
            processEnv.MYAPP_PORT,
            typeof processEnv.MYAPP_SSLS === 'string' ? JSON.parse(processEnv.MYAPP_SSLS) : processEnv.MYAPP_SSLS,
            typeof processEnv.MYAPP_LINKS === 'string' ? JSON.parse(processEnv.MYAPP_LINKS) : processEnv.MYAPP_LINKS,
            typeof processEnv.MYAPP_NODES === 'string' ? JSON.parse(processEnv.MYAPP_NODES) : processEnv.MYAPP_NODES,
            encode
        );
    }
}