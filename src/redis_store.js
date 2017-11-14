import _ from 'lodash';
import Redis from 'ioredis';

export default class RedisStore {
  constructor(opts) {
    this.dbName = opts.runningDbName || 'running_task_info';
    this.client = new Redis(opts.redis);
  }

  /**
   * 获取正在运行的所有任务
   * @returns null | {}
   */
  async getRunnings() {
    const raws = await this.client.hgetall(this.dbName);
    let runnings = _.mapValues(raws, (raw, key) => {
      try {
        return JSON.parse(raw);
      } catch (error) {
        console.error(error);
        return null;
      }
    });

    runnings = _.omitBy(runnings, (value, key) => {
      return (_.endsWith(key, ':total') || _.endsWith(key, ':success') || _.endsWith(key, ':failed'));
    });

    return runnings;
  }

  /**
   * 获取任务信息
   * @param {string} taskId
   * @returns null | {}
   */
  async getRunning(taskId) {
    const raw = await this.client.hget(this.dbName, taskId);
    try {
      return JSON.parse(raw);
    } catch (error) {
      console.error(error);
      return null;
    }
  }

  /**
   * 删除任务
   * @param {string} taskId
   * @returns 0 | 1
   */
  async delRunning(taskId) {
    const ret = await this.client.hdel(this.dbName, taskId);
    return ret;
  }

  /**
   * 更新任务信息
   * @param {string} taskId
   * @param {object} data
   * @returns 0 | 1
   */
  async setRunning(taskId, data) {
    const oldRaw = await this.client.hget(this.dbName, taskId);
    let old = null;
    try {
      old = JSON.parse(oldRaw);
    } catch (error) {
      console.error(error);
      old = {};
    }

    const newData = JSON.stringify(_.merge({}, old, data));
    const ret = await this.client.hset(this.dbName, taskId, newData);

    return ret;
  }

  async setStats(taskId, status) {
    const ret = await this.client.hincrby(this.dbName, `${taskId}:${status}`, 1);
    return ret;
  }

  async getStats(taskId) {
    const rets = await this.client
      .multi()
      .hget(this.dbName, `${taskId}:total`)
      .hget(this.dbName, `${taskId}:success`)
      .hget(this.dbName, `${taskId}:failed`)
      .exec();

    return {
      total: _.get(rets, '0.1', 0) || 0,
      success: _.get(rets, '1.1', 0) || 0,
      failed: _.get(rets, '2.1', 0) || 0,
    };
  }
}
