import type { SupabaseClient } from '@supabase/supabase-js';
import { saveCapture } from './client';
import type { Anchor, Capture, Message, Thread } from './model';

export type SavedPage = {page_id:string;version_id:string};
export type CommentStore = {
  read(source:string):Promise<{threads:Thread[];messages:Message[]}>;
  save(capture:Capture):Promise<SavedPage>;
  add(input:{source:string;page?:SavedPage;thread:string|null;anchor?:Anchor|null;body:string;id:string}):Promise<void>;
  resolve(thread:string,state:boolean):Promise<void>;
  subscribe?(refresh:()=>void):() => void;
  previewReplies?():Promise<void>;
};

export function savedComments(db:SupabaseClient, account:string):CommentStore {
  async function readAll<T>(table:string,page:string):Promise<T[]> {
    const rows:T[] = [];
    for (let offset=0; ; offset+=500) {
      const {data,error} = await db.from(table).select('*').eq('page_id',page)
        .order('created_at').order('id').range(offset,offset+499);
      if (error) throw error;
      rows.push(...data as T[]);
      if (data.length<500) return rows;
    }
  }
  return {
    async read(source) {
      const {data:page,error} = await db.from('wc_pages').select('id').eq('source_url',source).maybeSingle();
      if (error) throw error;
      if (!page) return {threads:[],messages:[]};
      const [threads,messages] = await Promise.all([
        readAll<Thread>('wc_threads',page.id),readAll<Message>('wc_messages',page.id),
      ]);
      return {threads,messages};
    },
    save:capture => saveCapture(db,account,capture),
    async add({source,page,thread,anchor,body,id}) {
      if (thread) {
        const {data,error} = await db.from('wc_pages').select('id,latest_version').eq('source_url',source).single();
        if (error) throw error;
        page = {page_id:data.id,version_id:data.latest_version};
      }
      if (!page) throw new Error('Save a selection first.');
      const {error} = await db.rpc('wc_add_message',{
        page:page.page_id,version:page.version_id,thread,selection:thread ? null : anchor,message:body,message_id:id,
      });
      if (error) throw error;
    },
    async resolve(thread,state) {
      const {error} = await db.rpc('wc_set_resolved',{thread,state});
      if (error) throw error;
    },
    subscribe(refresh) {
      const channel = db.channel('web-comments-'+crypto.randomUUID());
      for (const table of ['wc_pages','wc_threads','wc_messages']) {
        channel.on('postgres_changes',{schema:'public',table,event:'*'},refresh);
      }
      channel.subscribe();
      const interval = setInterval(refresh,8000);
      return () => { clearInterval(interval);void db.removeChannel(channel); };
    },
  };
}
