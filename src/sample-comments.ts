import type { CommentStore } from './comment-store';
import type { Message, Thread } from './model';

export function sampleComments():CommentStore {
  const threads:Thread[] = [];
  const messages:Message[] = [];
  const page = {page_id:crypto.randomUUID(),version_id:crypto.randomUUID()};

  return {
    async read() { return {threads:[...threads],messages:[...messages]}; },
    async save() { return page; },
    async add({thread,anchor,body,id}) {
      if (messages.some(message => message.id === id)) return;
      let target = threads.find(item => item.id === thread);
      if (!thread && anchor) {
        target = {id:crypto.randomUUID(),version_id:page.version_id,anchor,resolved:false};
        threads.push(target);
      }
      if (!target) throw new Error('Select text in the sample article first.');
      setResolved(target.id,false);
      messages.push({id,thread_id:target.id,body,role:'user',question:/(^|[^\p{L}\p{N}_])@AI([^\p{L}\p{N}_]|$)/iu.test(body),reply_to:null});
    },
    async resolve(thread,state) { setResolved(thread,state); },
    async previewReplies() {
      const answered = new Set(messages.map(message => message.reply_to));
      const pending = messages.filter(message => message.question && !answered.has(message.id));
      for (const question of pending) {
        const anchor = threads.find(thread => thread.id === question.thread_id)?.anchor.exact ?? '';
        const body = /evaporat|shade/i.test(anchor)
          ? 'In “How trees cool a street,” shade blocks direct sunlight and evaporation uses heat from the surrounding air. Both processes help keep the sidewalk cooler.'
          : 'The field notes suggest walking the same route at midday and in the late afternoon. Comparing where people wait tells you where shade would help most.';
        messages.push({id:crypto.randomUUID(),thread_id:question.thread_id,role:'assistant',body,question:false,reply_to:question.id});
      }
    },
  };

  function setResolved(thread:string,state:boolean) {
    const index = threads.findIndex(item => item.id === thread);
    if (index < 0) throw new Error('Thread not found.');
    threads[index] = {...threads[index],resolved:state};
  }
}
