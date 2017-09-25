import Q from '../src/queue';

const opt = {
  connectionString: 'redis://127.0.0.1:6379/0',
  handler: (job, done) => {
    console.log('handle:', job.data);
    job.progress(1, 10);
    done(null, { result: 1 });
  },
};
const q = new Q(opt);

q.on('ready', () => {
  console.log('1------ready');
}).on('done', () => {
  console.log('1------done');
}).on('completed', () => {
  console.log('1------completed');
});

q.ready('running_2');

setTimeout(async () => {
  await q.add('running_2', { msg: Math.random() * 1000 });
  await q.add('running_2', { msg: Math.random() * 1000 });
  await q.add('running_2', { msg: Math.random() * 1000 });
  await q.add('running_2', { msg: Math.random() * 1000 });

  await q.final('running_2');
}, 1000);
