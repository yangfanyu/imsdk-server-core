/**
 * 该类将符合本库模板的服务器配置文件解析为pm2启动所需的配置信息
 * pm2配置信息 http://pm2.keymetrics.io/docs/usage/application-declaration/
 */
import fs from 'fs';
import path from 'path';

export interface PM2AdapterConfig {
    clusters: { [key: string]: PM2AdapterNodeConfig[] };//集群节点列表集合
    defaults?: PM2AdapterNodeConfig;//节点默认的配置信息
    hostBind?: boolean;//是否根据服务器的域名来启动对应进程
}

export interface PM2AdapterNodeConfig {
    host?: string;//用于公开访问的 域名 或 外网ip地址
    inip?: string;//用于集群节点间连接的 域名 或 内网ip地址，若不设置则取host的值
    port?: number;//监听的端口号
    ssls?: { key: string, cert: string };//ssl证书的绝对路径，若不设置则表示此节点不启用ssl证书
    links?: string[];//该节点要连接的集群分组名称
    PM2config?: { [key: string]: any };//pm2配置信息 http://pm2.keymetrics.io/docs/usage/application-declaration/
}

export class PM2Adapter {
    private _appDir: string;
    private _appEnv: string;
    private _mchHost: string;
    private _servers: { [key: string]: PM2AdapterConfig };
    private _logLevel: 'none' | 'base' | 'full';
    private _encode: BufferEncoding;
    /**
     * @param processArgv 启动进程的参数，process.argv
     * @param appDir pm2启动时ecosystem.config.js文件的绝对路径
     * @param mchHostFile 主机名称文件绝对路径
     * @param serverConfig 服务器配置的文件绝对路径 或 服务器配置的数据内容
     * @param logLevel 打印解析过程的日志级别：none不打印、base打印基本信息、full打印完整信息
     * @param encode 编码默认值为utf8
     */
    public constructor(processArgv: string[], appDir: string, mchHostFile: string, serverConfig: string | { [key: string]: PM2AdapterConfig }, logLevel: 'none' | 'base' | 'full' = 'none', encode: BufferEncoding = 'utf8') {
        const envIndex = processArgv.indexOf('--env');
        if (envIndex < 0 || envIndex === processArgv.length - 1) {
            throw Error('processArgv: can not found --env xxxxxxxx');
        }
        this._appDir = appDir;
        this._appEnv = processArgv[envIndex + 1];//--env参数后面的值是运行环境类型
        this._mchHost = mchHostFile && fs.existsSync(mchHostFile) ? fs.readFileSync(mchHostFile, { encoding: encode }).trim() : null;//指定文件中读取的主机名称
        let serversStr = typeof serverConfig === 'string' ? fs.readFileSync(serverConfig, { encoding: encode }) : JSON.stringify(serverConfig);
        serversStr = serversStr.replace(new RegExp('\\${opt:appDir}', 'gm'), this._appDir);
        serversStr = serversStr.replace(new RegExp('\\${opt:appEnv}', 'gm'), this._appEnv);
        serversStr = serversStr.replace(new RegExp('\\${opt:mchHost}', 'gm'), this._mchHost);
        this._servers = JSON.parse(serversStr);//指定文件中读取服务器配置信息
        this._logLevel = logLevel;
        this._encode = encode;
        if (this._logLevel === 'base' || this._logLevel === 'full') {
            console.log('---base info---');
            console.log('appDir:', this._appDir);
            console.log('appEnv:', this._appEnv);
            console.log('mchHost:', this._mchHost);
        }
    }
    /**
     * 返回pm2启动的apps
     */
    public getApps(): { [key: string]: any }[] {
        const clusters = this._servers[this._appEnv].clusters;
        const hostBind = this._servers[this._appEnv].hostBind || false;
        const defaults = this._servers[this._appEnv].defaults || {};
        if (hostBind && !this._mchHost) throw Error('Cant not read hostname.');
        const apps = [];
        const nodes: any = {};
        const instEnvName = 'env_' + this._appEnv;
        for (let appName in clusters) {
            if (clusters.hasOwnProperty(appName)) {
                const cluster = clusters[appName];
                nodes[appName] = [];
                for (let i = 0; i < cluster.length; i++) {
                    const item = cluster[i];
                    //进程的pm2属性
                    const inst: { [key: string]: any } = {};
                    Object.assign(inst, defaults.PM2config || {});
                    Object.assign(inst, item.PM2config || {});
                    inst.name = (defaults.PM2config ? defaults.PM2config.name || 'app' : 'app') + '-' + (appName + '-' + (item.port || defaults.port || i));
                    //进程的应用参数
                    inst[instEnvName] = {
                        NODE_ENV: (this._appEnv === 'develop' || this._appEnv === 'development') ? 'development' : 'production',//nodejs运行环境(定义为production有利于提高性能)
                        MYAPP_DIR: this._appDir,//应用启动根目录
                        MYAPP_ENV: this._appEnv,//应用运行环境
                        MYAPP_NAME: appName,//分组类型
                        MYAPP_HOST: (item.host === undefined ? defaults.host : item.host) || null,//外网地址
                        MYAPP_INIP: (item.inip === undefined ? defaults.inip : item.inip) || null,//内网ip
                        MYAPP_PORT: (item.port === undefined ? defaults.port : item.port) || null,//端口号码
                        MYAPP_SSLS: (item.ssls === undefined ? defaults.ssls : item.ssls) || null,//证书加载路径
                        MYAPP_LINKS: (item.links === undefined ? defaults.links : item.links) || [],//需要连接的进程分组（他妈的某些版本的pm2不支持数组）
                        MYAPP_NODES: nodes//全部节点集合
                    };
                    //集群的节点数据
                    nodes[appName].push({
                        host: inst[instEnvName].MYAPP_HOST,
                        inip: inst[instEnvName].MYAPP_INIP,
                        port: inst[instEnvName].MYAPP_PORT,
                        ssls: !!(inst[instEnvName].MYAPP_SSLS)
                    });
                    //对应主机的apps
                    if (!hostBind || inst[instEnvName].MYAPP_HOST === this._mchHost) {
                        apps.push(inst);
                    }
                }
            }
        }
        //将对象属性转换为字符串
        for (let i = 0; i < apps.length; i++) {
            const inst = apps[i];
            inst[instEnvName].MYAPP_SSLS = JSON.stringify(inst[instEnvName].MYAPP_SSLS);
            inst[instEnvName].MYAPP_LINKS = JSON.stringify(inst[instEnvName].MYAPP_LINKS);
            inst[instEnvName].MYAPP_NODES = JSON.stringify(inst[instEnvName].MYAPP_NODES);
        }
        if (this._logLevel === 'full') {
            console.log('---apps info---');
            console.log('total', apps.length);
            console.log(apps);
        }
        return apps;
    }
    /**
     * 将pm2启动的apps写入到文件
     * @param dirname 写入文件的文件夹绝对路径
     * @param json 是否写入到json文件
     */
    public saveApps(dirname: string, json: boolean = false) {
        if (!this.mkdirsSync(dirname)) {
            throw Error('cannot create dir ' + dirname);
        }
        let filepath = dirname + 'ecosystem' + (json ? '.json' : '.config.js');
        fs.writeFileSync(filepath, (json ? '' : 'module.exports = ') + JSON.stringify({ apps: this.getApps() }, null, 4));
        if (this._logLevel === 'base' || this._logLevel === 'full') {
            console.log('save to -> ', filepath, ' finished.');
        }
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

    public get encode() { return this._encode };

}