import mongoose from 'mongoose';

mongoose.connect('mongodb://127.0.0.1:27017/queue');

const runningSchema = new mongoose.Schema({
  name: {
    type: String,
    unique: true,
  },
  task: {
    type: Object,
  },
});
const model = mongoose.model('running', runningSchema);

export default model;
