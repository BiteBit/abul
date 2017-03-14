import Q from '../dist/queue';

import model from './db';

const opt = {
  runningDb: {
    getRunning: async () => {
      const ret = await model.find().lean();
      return ret;
    },
    setRunning: async (name, task) => {
      await model.create({name, task});
    },
  },
  handler: (job, done) => {
    console.log('handle:', job.data);
    job.progress(1, 10);
    done(new Error(11), {result: 1});
  },
};

const q = new Q(opt);

setTimeout(() => {
  // q.add('running_4', {msg: Math.random() * 1000});
  // q.add('running_4', {msg: Math.random() * 1000});
  // q.add('running_4', {msg: Math.random() * 1000});
  // q.add('running_4', {msg: Math.random() * 1000});
  // q.add('running_4', {msg: Math.random() * 1000});
  // q.add('running_4', {msg: Math.random() * 1000});

  // q.add('running_1', {msg: Math.random() * 1000});
  // q.add('running_1', {msg: Math.random() * 1000});
  // q.add('running_1', {msg: Math.random() * 1000});

  q.add('running_2', {msg: Math.random() * 1000});
}, 10000);
