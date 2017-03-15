import _ from 'lodash';
import assert from 'assert';
import Debug from 'debug';
import { EventEmitter } from 'events';
import Promise from 'bluebird';
import Queue from 'bull';

const debug = Debug('abul');

class Abul extends EventEmitter {
  constructor(opts) {
    super();

    // 参数校验
    assert.equal(typeof opts.handler, 'function');
    assert.equal(typeof opts.connectionString === 'string' || opts.connectionString === undefined, true);
    assert.equal(typeof opts.concurrency === 'number' || opts.concurrency === undefined, true);
    assert.equal(typeof opts.runningDb.findRunning, 'function');
    assert.equal(typeof opts.runningDb.createRunning, 'function');
    assert.equal(typeof opts.runningDb.removeRunning, 'function');
    assert.equal(typeof opts.addExpire === 'number' || opts.addExpire === undefined, true);

    // 需要外部配置的参数
    // 队列处理器
    this.handler = opts.handler;

    // Queue create的参数
    this.connectionString = opts.connectionString;

    // 队列并发数
    this.concurrency = opts.concurrency || 5;

    // 记录正在运行的任务
    // 需要实现findRunning方法，返回正在运行的任务数组，并且每个元素必须包含name [{name: 'task_1'}]
    // 需要实现createRunning方法，持久化一个任务到正在运行的任务数组中，以便其他WORKER通过findRunning获取正在运行的任务来创建处理任务
    // removeRunning
    this.runningDb = opts.runningDb;

    // 任务添加的过期时间
    this.addExpire = opts.addExpire || 30 * 1000;

    ////////////////////////////////////////////////////////////////////////////////////////////////
    // 内部数据结构，不是参数
    ////////////////////////////////////////////////////////////////////////////////////////////////

    // 进程中记录的正在运行的任务
    // key    taskname任务名称，key必须是唯一的
    // value  任务队列实例
    this.runningTask = {};

    // 记录任务最近一次add时间
    // key    taskname任务名称，key必须是唯一的
    // value  boolean
    this.runningTaskLastAdd = {};

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
      const runningTaskNow = await self.runningDb.findRunning();
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

      await this.runningTask[oldTaskName].empty();

      // 关闭worker
      debug('close start');
      await this.runningTask[oldTaskName].close(true);
      debug('close finish');

      // 删除当前进程里的任务记录
      delete this.runningTask[oldTaskName];
      delete this.runningTaskLastAdd[oldTaskName];
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
      await this.ready(newTaskName, false);
    });
  }

  /**
   * 检查任务是否完成
   * @param {string} taskName
   * @param {object} status
   * @param {object} queue
   * @private
   */
  async startDoneChecker(taskName, queue) {
    const status = await queue.getJobCounts();

    debug(taskName, status);
    // 等待任务为0，延迟任务为0，活动中的任务为0

    function isLikelyDone(sts) {
      return sts.wait === 0 && sts.delayed === 0 && sts.active === 0;
    }

    // 如果几种类型的任务都为不0，那么任务肯定没完成，不再进行详细的检测
    if (!isLikelyDone(status)) {
      return;
    }

    // 过xx秒后再次检查，如果仍然通过，那么发出任务完成信号，或者检测错误可能是queue连接已经被断开、销毁
    await Promise.delay(this.addExpire * 1.5)
      .then(async () => {
        try {
          const newStatus = await queue.getJobCounts();

          // 再次检测几种类型的任务是否为0，并且任务是否已经很久没有添加
          if (isLikelyDone(newStatus) && this.isAddFinish(taskName)) {
            debug('------------------- CHECK DONE -------------------');
            this.emit('done', taskName);
            this.runningDb.removeRunning(taskName);
          }
        } catch (error) {
          debug('------------------- CHECK DONE error -------------------', error);
          this.emit('done', taskName);
          this.runningDb.removeRunning(taskName);
        }
      });
  }

  /**
   * 检测指定任务是否完成添加
   * 如果任务最近的添加时间超过指定的期限，那么认为任务已经添加完毕
   * @param {string} taskName
   * @private
   */
  isAddFinish(taskName) {
    return Date.now() - this.runningTaskLastAdd[taskName] > this.addExpire;
  }

  /**
   * 准备开始一个推送任务
   * @param {string} newTaskName
   * @public
   */
  async ready(newTaskName, isNew = true) {
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

        this.emit.apply(this, args);

        if (eventName === 'error') {
          debug(args);
          process.exit();
        }

        // 检测任务是否全部完成
        if ((eventName === 'completed' || eventName === 'failed')) {
          await this.startDoneChecker(newTaskName, queue);
        }
      });
    });

    // 设置任务处理器
    queue.process(this.concurrency, this.handler);

    // 保存到当前进程的任务记录
    this.runningTask[newTaskName] = queue;

    // 保存到正在运行的任务记录中
    if (isNew) {
      await this.runningDb.createRunning(newTaskName);
    }

    // 等待连接结果，才返回是否ready
    await new Promise((resolve, reject) => {
      queue.once('ready', resolve);
      queue.once('error', reject);
    });
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

    // 设置任务最近添加的时间戳
    this.runningTaskLastAdd[name] = Date.now();

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
