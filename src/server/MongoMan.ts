/**
 * 对node-mongodb-native封装的类
 * node-mongodb-native相关信息：http://mongodb.github.io/node-mongodb-native/
 */
import { MongoClient, ObjectId } from 'mongodb';
import type {
    Db,
    MongoClientOptions,
    MongoClientCommonOption,
    DbCollectionOptions,
    CollectionInsertOneOptions,
    CollectionInsertManyOptions,
    FilterQuery,
    FindOneOptions,
    UpdateQuery,
    UpdateOneOptions,
    UpdateManyOptions,
    CommonOptions,
    MongoCountPreferences,
    FindOneAndUpdateOption,
    FindOneAndDeleteOption,
    CollectionAggregationOptions,
    Collection,
    SessionOptions,
    TransactionOptions,
    WithTransactionCallback,
} from 'mongodb';
import type { Logger } from 'log4js';
import type { EnvContext } from './EnvContext';

export interface MongoManConfig {
    url?: string;//MongoClient地址
    urlOptions?: MongoClientOptions;//MongoClient选项
    db?: string;//数据库名
    dbOptions?: MongoClientCommonOption;//数据库连接参数
}

export class MongoMan {
    private _context: EnvContext;
    private _config: MongoManConfig;
    private _logger: Logger;//log4js实例
    private _client: MongoClient;//客户端实例
    private _db: Db;//数据库实例
    /**
     * @param context 上下文包装类实例
     * @param category 日志分类
     * @param config 配置信息
     */
    public constructor(context: EnvContext, category: string, config: MongoManConfig = {}) {
        this._context = context;
        this._config = config;
        //绑定log4js实例
        this._logger = context.getLogger(category);
        //mongo相关引用
        this._client = null;//客户端实例
        this._db = null;//数据库实例
    }
    /**
     * 建立数据库连接
     */
    public async connect(): Promise<void> {
        try {
            this._client = new MongoClient(this._config.url, this._config.urlOptions);
            await this._client.connect();
            this._db = this._client.db(this._config.db, this._config.dbOptions);
            this._logger.info(this._config.url, this._config.db, 'was connected.');
        } catch (e) {
            this._logger.error(this._config.url, this._config.db, 'connect error,', e);
        }
    }
    /**
     * 关闭数据库连接
     * @param force 
     */
    public async close(force: boolean = false): Promise<void> {
        try {
            if (this._client) {
                await this._client.close(force);
                this._client = null;
                this._db = null;
            }
            this._logger.info(this._config.url, this._config.db, 'was closed.');
        } catch (e) {
            this._logger.error(this._config.url, this._config.db, 'close error,', e);
        }
    }
    /**
     * 插入单条记录
     * @param table 
     * @param doc 
     * @param insertOptions 
     * @param tableOptions 
     * @returns 当返回值<0：操作失败。当返回值>=0：操作成功的数量
     */
    public async insertOne<T>(table: string, doc: T, insertOptions?: CollectionInsertOneOptions, tableOptions?: DbCollectionOptions): Promise<number> {
        try {
            const result = await this._db.collection(table, tableOptions).insertOne(doc, insertOptions);
            this._logger.debug(this._config.url, this._config.db, 'insertOne', ...arguments, result.insertedCount);
            return result.insertedCount;
        } catch (e) {
            this._logger.error(this._config.url, this._config.db, 'insertOne', ...arguments, e);
            return -1;
        }
    }
    /**
     * 插入多条记录
     * @param table 
     * @param docs 
     * @param insertOptions 
     * @param tableOptions 
     * @returns 当返回值<0：操作失败。当返回值>=0：操作成功的数量
     */
    public async insertMany<T>(table: string, docs: T[], insertOptions?: CollectionInsertManyOptions, tableOptions?: DbCollectionOptions): Promise<number> {
        try {
            const result = await this._db.collection(table, tableOptions).insertMany(docs, insertOptions);
            this._logger.debug(this._config.url, this._config.db, 'insertMany', ...arguments, result.insertedCount);
            return result.insertedCount;
        } catch (e) {
            this._logger.error(this._config.url, this._config.db, 'insertMany', ...arguments, e);
            return -1;
        }
    }
    /**
     * 查找单条记录
     * @param table 
     * @param query 
     * @param findOptions 
     * @param tableOptions 
     * @returns 当返回值为null：操作失败。
     */
    public async findOne<T>(table: string, query: FilterQuery<T>, findOptions?: FindOneOptions<any>, tableOptions?: DbCollectionOptions): Promise<T> {
        try {
            const result = await this._db.collection(table, tableOptions).findOne(query, findOptions);
            this._logger.debug(this._config.url, this._config.db, 'findOne', ...arguments, result);
            return result;
        } catch (e) {
            this._logger.error(this._config.url, this._config.db, 'findOne', ...arguments, e);
            return null;
        }
    }
    /**
     * 查找多条记录
     * @param table 
     * @param query 
     * @param join 
     * @param findOptions 
     * @param tableOptions 
     * @returns 当返回值为null：操作失败。
     */
    public async findMany<T, Z>(table: string, query: FilterQuery<T>, join?: FindJoinOpions<Z>, findOptions?: FindOneOptions<any>, tableOptions?: DbCollectionOptions): Promise<T[]> {
        try {
            const result = await this._db.collection(table, tableOptions).find(query, findOptions).toArray();
            if (result.length > 0 && join) {
                //模拟单表左外连接
                let equalsId = false;
                join.query = join.query || {};
                join.query.$or = [];
                for (let i = 0; i < result.length; i++) {
                    const param: any = {};
                    param[join.toField] = result[i][join.fromField];
                    equalsId = typeof param[join.toField] === 'object';
                    join.query.$or.push(param);
                }
                const joinResult = await this._db.collection(join.table, join.tableOptions).find(join.query, join.findOptions).toArray();
                for (let i = 0; i < result.length; i++) {
                    const doc = result[i];
                    const fromValue = doc[join.fromField];
                    doc[join.resField] = join.onlyOne ? {} : [];
                    for (let k = 0; k < joinResult.length; k++) {
                        const item = joinResult[k];
                        if ((equalsId && fromValue && fromValue.equals(item[join.toField])) || (!equalsId && fromValue === item[join.toField])) {
                            if (join.onlyOne) {
                                doc[join.resField] = item;
                                break;
                            } else {
                                doc[join.resField].push(item);
                            }
                        }
                    }
                }
            }
            this._logger.debug(this._config.url, this._config.db, 'findMany', ...arguments, result);
            return result;
        } catch (e) {
            this._logger.error(this._config.url, this._config.db, 'findMany', ...arguments, e);
            return null;
        }
    }
    /**
     * 更新单条记录
     * @param table 
     * @param filter 
     * @param update 
     * @param updateOptions 
     * @param tableOptions 
     * @returns 当返回值<0：操作失败。当返回值>=0：操作成功的数量
     */
    public async updateOne<T>(table: string, filter: FilterQuery<T>, update: UpdateQuery<T>, updateOptions?: UpdateOneOptions, tableOptions?: DbCollectionOptions): Promise<number> {
        try {
            const result = await this._db.collection(table, tableOptions).updateOne(filter, update, updateOptions);
            this._logger.debug(this._config.url, this._config.db, 'updateOne', ...arguments, result.modifiedCount, result.matchedCount, result.upsertedCount);
            return result.modifiedCount || result.matchedCount || result.upsertedCount;
        } catch (e) {
            this._logger.error(this._config.url, this._config.db, 'updateOne', ...arguments, e);
            return -1;
        }
    }
    /**
     * 更新多条记录
     * @param table 
     * @param filter 
     * @param update 
     * @param updateOptions 
     * @param tableOptions 
     * @returns 当返回值<0：操作失败。当返回值>=0：操作成功的数量
     */
    public async updateMany<T>(table: string, filter: FilterQuery<T>, update: UpdateQuery<T>, updateOptions?: UpdateManyOptions, tableOptions?: DbCollectionOptions): Promise<number> {
        try {
            const result = await this._db.collection(table, tableOptions).updateMany(filter, update, updateOptions);
            this._logger.debug(this._config.url, this._config.db, 'updateMany', ...arguments, result.modifiedCount, result.matchedCount, result.upsertedCount);
            return result.modifiedCount || result.matchedCount || result.upsertedCount;
        } catch (e) {
            this._logger.error(this._config.url, this._config.db, 'updateMany', ...arguments, e);
            return -1;
        }
    }
    /**
     * 删除单条记录
     * @param table 
     * @param filter 
     * @param deleteOptions 
     * @param tableOptions 
     * @returns 当返回值<0：操作失败。当返回值>=0：操作成功的数量
     */
    public async deleteOne<T>(table: string, filter: FilterQuery<T>, deleteOptions?: CommonOptions, tableOptions?: DbCollectionOptions): Promise<number> {
        try {
            const result = await this._db.collection(table, tableOptions).deleteOne(filter, deleteOptions);
            this._logger.debug(this._config.url, this._config.db, 'deleteOne', ...arguments, result.deletedCount);
            return result.deletedCount;
        } catch (e) {
            this._logger.error(this._config.url, this._config.db, 'deleteOne', ...arguments, e);
            return -1;
        }
    }
    /**
     * 删除多条记录
     * @param table 
     * @param filter 
     * @param deleteOptions 
     * @param tableOptions 
     * @returns 当返回值<0：操作失败。当返回值>=0：操作成功的数量
     */
    public async deleteMany<T>(table: string, filter: FilterQuery<T>, deleteOptions?: CommonOptions, tableOptions?: DbCollectionOptions): Promise<number> {
        try {
            const result = await this._db.collection(table, tableOptions).deleteMany(filter, deleteOptions);
            this._logger.debug(this._config.url, this._config.db, 'deleteMany', ...arguments, result.deletedCount);
            return result.deletedCount;
        } catch (e) {
            this._logger.error(this._config.url, this._config.db, 'deleteMany', ...arguments, e);
            return -1;
        }
    }
    /**
     * 查询记录数量
     * @param table 
     * @param query 
     * @param countOptions 
     * @param tableOptions 
     * @returns 当返回值<0：操作失败。当返回值>=0：操作成功的数量
     */
    public async countDocuments<T>(table: string, query?: FilterQuery<T>, countOptions?: MongoCountPreferences, tableOptions?: DbCollectionOptions): Promise<number> {
        try {
            const result = await this._db.collection(table, tableOptions).countDocuments(query, countOptions);
            this._logger.debug(this._config.url, this._config.db, 'countDocuments', ...arguments, result);
            return result;
        } catch (e) {
            this._logger.error(this._config.url, this._config.db, 'countDocuments', ...arguments, e);
            return -1;
        }
    }
    /**
     * 这个是原子操作
     * @param table 
     * @param filter 
     * @param update 
     * @param findUpdateOptions 
     * @param tableOptions 
     * @returns 当返回值为null：操作失败。
     */
    public async findOneAndUpdate<T>(table: string, filter: FilterQuery<T>, update: UpdateQuery<T>, findUpdateOptions?: FindOneAndUpdateOption<T>, tableOptions?: DbCollectionOptions): Promise<T> {
        try {
            const result = await this._db.collection(table, tableOptions).findOneAndUpdate(filter, update, findUpdateOptions);
            this._logger.debug(this._config.url, this._config.db, 'findOneAndUpdate', ...arguments, result.value);
            return result.value;
        } catch (e) {
            this._logger.error(this._config.url, this._config.db, 'findOneAndUpdate', ...arguments, e);
            return null;
        }
    }
    /**
     * 这个是原子操作
     * @param table 
     * @param filter 
     * @param findDeleteOptions 
     * @param tableOptions 
     * @returns 当返回值为null：操作失败。
     */
    public async findOneAndDelete<T>(table: string, filter: FilterQuery<T>, findDeleteOptions?: FindOneAndDeleteOption<T>, tableOptions?: DbCollectionOptions): Promise<T> {
        try {
            const result = await this._db.collection(table, tableOptions).findOneAndDelete(filter, findDeleteOptions);
            this._logger.debug(this._config.url, this._config.db, 'findOneAndDelete', ...arguments, result.value);
            return result.value;
        } catch (e) {
            this._logger.error(this._config.url, this._config.db, 'findOneAndDelete', ...arguments, e);
            return null;
        }
    }
    /**
     * 聚合操作
     * @param table 
     * @param aggregatePipeline 
     * @param aggregateOptions 
     * @param tableOptions 
     * @returns 当返回值为null：操作失败。
     */
    public async aggregate<T>(table: string, aggregatePipeline?: object[], aggregateOptions?: CollectionAggregationOptions, tableOptions?: DbCollectionOptions): Promise<T[]> {
        try {
            const result = await this._db.collection(table, tableOptions).aggregate(aggregatePipeline, aggregateOptions).toArray();
            this._logger.debug(this._config.url, this._config.db, 'aggregate', ...arguments, result);
            return result;
        } catch (e) {
            this._logger.error(this._config.url, this._config.db, 'aggregate', ...arguments, e);
            return null;
        }
    }
    /**
     * 使用withTransaction函数来进行事务操作
     * 官方解释：Use withTransaction to start a transaction, execute the callback, and commit (or abort on error)
     * Note: The callback for withTransaction MUST be async and/or return a Promise.
     * Important: You must pass the session to the operations
     * @param callback 未抛出异常则提交事务，抛出异常则回滚事务，务必将回调参数session传入数据库操作中
     * @param sessionOptions 
     * @param transactionOptions 
     * @returns 当返回值为null：操作成功。当返回值为string：操作失败的描述。
     */
    public async withTransaction(callback: WithTransactionCallback, sessionOptions?: SessionOptions, transactionOptions?: TransactionOptions): Promise<string> {
        const session = this._client.startSession(sessionOptions);
        this._logger.debug(this._config.url, this._config.db, 'withTransaction -> startSession', ...arguments);
        let errmsg: string = null;
        try {
            this._logger.debug(this._config.url, this._config.db, 'withTransaction -> withTransaction', ...arguments);
            await session.withTransaction(callback, transactionOptions);
        } catch (e) {
            errmsg = e.message;
            this._logger.error(this._config.url, this._config.db, 'withTransaction -> catchError', ...arguments, e);
        } finally {
            session.endSession();
            this._logger.debug(this._config.url, this._config.db, 'withTransaction -> endSession', ...arguments);
        }
        return errmsg;
    }
    /**
     * 使用startTransaction、commitTransaction、abortTransaction函数来进行事务操作
     * @param callback 未抛出异常则提交事务，抛出异常则回滚事务，务必将回调参数session传入数据库操作中
     * @param sessionOptions 
     * @param transactionOptions 
     * @returns 当返回值为null：操作成功。当返回值为string：操作失败的描述。
     */
    public async handTransaction(callback: WithTransactionCallback, sessionOptions?: SessionOptions, transactionOptions?: TransactionOptions): Promise<string> {
        const session = this._client.startSession(sessionOptions);
        this._logger.debug(this._config.url, this._config.db, 'handTransaction -> startSession', ...arguments);
        let errmsg: string = null;
        try {
            session.startTransaction(transactionOptions);
            this._logger.debug(this._config.url, this._config.db, 'handTransaction -> startTransaction', ...arguments);
            await callback(session);
            await session.commitTransaction();
            this._logger.debug(this._config.url, this._config.db, 'handTransaction -> commitTransaction', ...arguments);
        } catch (e) {
            errmsg = e.message;
            await session.abortTransaction();
            this._logger.error(this._config.url, this._config.db, 'handTransaction -> abortTransaction', ...arguments, e);
        } finally {
            session.endSession();
            this._logger.debug(this._config.url, this._config.db, 'handTransaction -> endSession', ...arguments);
        }
        return errmsg;
    }
    /**
     * 获取可操作的集合
     * @param table 
     * @param tableOptions 
     */
    public collection(table: string, tableOptions?: DbCollectionOptions): Collection<any> {
        return this._db.collection(table, tableOptions);
    }
    /**
     * 创建ObjectId
     */
    public createObjectId(): ObjectId {
        return new ObjectId();
    }
    /**
     * 16进制转ObjectId
     * @param hexstr 
     */
    public hexstr2ObjectId(hexstr: string): ObjectId {
        try {
            return ObjectId.createFromHexString(hexstr);
        } catch (e) {
            return ObjectId.createFromHexString('000000000000000000000000');
        }
    }
    public get context(): EnvContext { return this._context; }
    public get client(): MongoClient { return this._client; };
    public get db(): Db { return this._db; };
}

interface FindJoinOpions<Z> {
    fromField: string;
    toField: string;
    resField: string;
    table: string;
    onlyOne?: boolean;
    query?: FilterQuery<Z>;
    findOptions?: FindOneOptions<any>;
    tableOptions?: DbCollectionOptions;
}