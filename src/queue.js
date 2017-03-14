import _ from 'lodash';
import assert from 'assert';
import Debug from 'debug';
import {EventEmitter} from 'events';
import Promise from 'bluebird';
import Queue from 'bull';

const debug = Debug('abul');

class Abul extends EventEmitter {
  constructor(opts) {
    super();

    // 参数校验
    assert.equal(typeof opts.handler, 'function');
    assert.equal(typeof opts.connectionString === 'string' || opts.connectionString === undefined, true);
    assert.equal(typeof opts.concurrency === 'number' || opts.connectionString === undefined, true);
    assert.equal(typeof opts.runningDb.getRunning, 'function');
    assert.equal(typeof opts.runningDb.setRunning, 'function');

    // 需要外部配置的参数
    // 队列处理器
    this.handler = opts.handler;

    // Queue create的参数
    this.connectionString = opts.connectionString;

    // 队列并发数
    this.concurrency = opts.concurrency || 5;

    // 记录正在运行的任务
    // 需要实现getRunning方法，返回正在运行的任务数组，并且每个元素必须包含name [{name: 'task_1'}]
    // 需要实现setRunning方法，持久化一个任务到正在运行的任务数组中，以便其他WORKER通过getRunning获取正在运行的任务来创建处理任务
    this.runningDb = opts.runningDb;

    // 进程中记录的正在运行的任务
    // key    taskname任务名称，key必须是唯一的
    // value  任务队列实例
    this.runningTask = {};

    // 定时加载正在运行的任务
    Abul.runningTick(this);
    setInterval(Abul.runningTick(this), 5000);
  }

  /**
   * 定时从DB中加载正在运行的任务，并和当前进程中记录的正在运行的任务做DIFF
   * 如果任务已经完成，那么关闭当前进程中正在运行的任务
   * 如果是新任务，那么在当前进程中添加处理
   * @param {*} self
   * @private
   */
  static runningTick(self) {
    return async () => {
      debug('--------------------------- LOAD TICK START---------------------------');

      // 最新的正在运行的任务
      const runningTaskNow = await self.runningDb.getRunning();
      const runningTaskNowNames = _.map(runningTaskNow, (item) => { return item.name; });

      // 当前进程中记录的正在运行的任务
      const runningOldTaskNames = _.keys(self.runningTask);

      debug('RunningTick', 'DB RUNNING:', runningTaskNowNames, 'PROCESS RUNNING:', runningOldTaskNames);

      // 清理已完成任务
      const finishTaskNames = _.differenceBy(_.keys(self.runningTask), runningTaskNowNames);
      await self.cleanOldJobQueue(finishTaskNames);

      // 新任务开始响应
      const newTaskNames = _.differenceBy(runningTaskNowNames, _.keys(self.runningTask));
      await self.initNewJobQueue(newTaskNames);

      debug('--------------------------- LOAD TICK FINISH---------------------------');
    };
  }

  /**
   * 清理已完成任务
   * @private
   */
  async cleanOldJobQueue(finishTaskNames) {
    debug('FINISH TASKS: ', finishTaskNames);
    await Promise.each(finishTaskNames, async (oldTaskName) => {
      debug('CLEAN OLD TASK:', oldTaskName);

      // 关闭worker
      await this.runningTask[oldTaskName].close();

      // 删除当前进程里的任务记录
      delete this.runningTask[oldTaskName];
    });
  }

  /**
   * 初始化新增的任务
   * @private
   */
  async initNewJobQueue(newTaskNames) {
    debug('NEW TASKS: ', newTaskNames);

    await Promise.each(newTaskNames, async (newTaskName) => {
      debug('PROCESS NEW TASK', newTaskName);

      // 开始准备处理该类型的任务
      await this.ready(newTaskName);
    });
  }

  /**
   * 准备开始一个推送任务
   * @param {string} newTaskName
   * @public
   */
  async ready(newTaskName) {
    let queue = this.runningTask[newTaskName];

    // 如果已经存在，那么不再重复创建
    if (queue) {
      return;
    }

    // 创建任务队列worker
    queue = new Queue(newTaskName, this.connectionString);

    // 重新emit事件类型，增加task name参数为第一个参数
    _.each([
      'ready',
      'error',
      'active',
      'stalled',
      'progress',
      'completed',
      'failed',
      'paused',
      'resumed',
      'cleaned',
    ], (eventName) => {
      queue.on(eventName, async (...args) => {
        debug(`QUEUE EVENT:${eventName}`, newTaskName);

        args.unshift(newTaskName);
        args.unshift(eventName);
        this.emit.call(this, args);

        // 检测任务是否全部完成
        if (eventName === 'completed' || eventName === 'failed') {
          const status = await queue.getJobCounts();
          debug(status);

          // 等待任务为0，延迟任务为0，活动中的任务为0
          if (status.wait === 0 && status.delayed === 0 && status.active === 0) {
            debug('QUEUE EVENT:done', newTaskName);
            this.emit('done', newTaskName);
          }
        }
      });
    });

    // 设置任务处理器
    queue.process(this.concurrency, this.handler);

    // 保存到当前进程的任务记录
    this.runningTask[newTaskName] = queue;
  }

  /**
   * 向一个任务队列中增加任务，使用name做为队列名称，唯一不重复
   * 重试3次
   * 每次回退10秒
   * 任务时间1分钟
   * 完成后自动删除任务，减少内存占用
   * @public
   */
  async add(name, task, options) {
    assert.equal(typeof name, 'string');
    assert.equal(typeof task, 'object');
    assert.equal(typeof options === 'object' || options === undefined, true);

    debug('READY TO ADD TASK:', name, task, options);
    const queue = this.runningTask[name];

    if (!queue) {
      throw new Error(`Job [${name}] is not running!`);
    }

    return queue.add(task, _.defaults(options, {
      attempts: 3,
      timeout: 60 * 1000,
      removeOnComplete: true,
      backoff: {
        type: 'fixed',
        delay: 10 * 1000,
      },
    }));
  }
}

export default Abul;
