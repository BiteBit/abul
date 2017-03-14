import Q from '../src/queue';

import model from './db';

const opt = {
  runningDb: {
    findRunning: async () => {
      const ret = await model.find().lean();
      return ret;
    },
    createRunning: async (name, task) => {
      await model.create({name, task});
    },
    removeRunning: async (name) => {
      await model.create({name});
    },
  },
  handler: (job, done) => {
    console.log('handle:', job.data);
    job.progress(1, 10);
    done(null, {result: 1});
  },
};

const q = new Q(opt);

q.on('ready', () => {
  console.log('1------ready');
});

q.on('done', () => {
  console.log('1------done');
});

q.on('completed', () => {
  console.log('1------completed');
});

setTimeout(() => {
  q.ready('running_2');

  q.add('running_2', {msg: Math.random() * 1000});
}, 1000);
