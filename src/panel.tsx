import React, { useEffect, useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import type { SupabaseClient } from '@supabase/supabase-js';
import './styles.css';
import { errorText } from './client';
import { ExtensionAccount } from './extension-account';
import { savedComments, type CommentStore } from './comment-store';
import { DocumentPanel, type DocumentView } from './document-panel';
import type { Capture, Thread } from './model';

type View = {id:number; tabUrl:string; source:string; title:string; pdf:boolean};
const viewer = chrome.runtime.getURL('viewer.html');
async function activeView():Promise<View|null> {
  const [tab] = await chrome.tabs.query({active:true,currentWindow:true});
  if (!tab?.id || !tab.url) return null;
  const pdf = tab.url.startsWith(viewer + '?');
  const source = pdf ? new URL(tab.url).searchParams.get('url') ?? '' : tab.url;
  if (!/^(https?|file):\/\//.test(source)) return null;
  if (!pdf && source.startsWith('file:') && !/\.pdf$/i.test(new URL(source).pathname)) return null;
  return {id:tab.id,tabUrl:tab.url,source,title:tab.title || source,pdf};
}
async function send<T>(view:View,type:string, data:object = {}):Promise<T> {
  const response = view.pdf
    ? await chrome.runtime.sendMessage({type,targetTab:view.id,...data})
    : await chrome.tabs.sendMessage(view.id,{type,...data});
  if (response?.error) throw new Error(response.error);
  return response as T;
}

function Workspace({db,owner,origin}:{db:SupabaseClient;owner:string;origin:string}) {
  const [view,setView] = useState<View|null>(null);
  useEffect(() => {
    let version = 0;
    const update = () => {
      const next = ++version;
      void activeView().then(active => { if (version === next) setView(previous => previous && active &&
        previous.id===active.id && previous.tabUrl===active.tabUrl && previous.title===active.title ? previous : active); });
    };
    update();
    chrome.tabs.onActivated.addListener(update);
    chrome.tabs.onUpdated.addListener(update);
    chrome.windows.onFocusChanged.addListener(update);
    return () => {
      version++;
      chrome.tabs.onActivated.removeListener(update);
      chrome.tabs.onUpdated.removeListener(update);
      chrome.windows.onFocusChanged.removeListener(update);
    };
  },[]);
  const store = useMemo(() => savedComments(db,owner),[db,owner]);
  return view ? <ChromeDocument key={`${view.id}:${view.tabUrl}`} {...{store,origin,view}}/>
    : <p className="empty">Open a webpage or PDF to start annotating.</p>;
}

function ChromeDocument({store,origin,view}:{store:CommentStore;origin:string;view:View}) {
  const page = useMemo<DocumentView>(() => ({
    source:view.source,
    title:view.title,
    async capture() {
      try {
        return await send<Capture>(view,view.pdf?'wc-pdf-capture':'wc-html-capture',{uploadPdf:true});
      } catch (error) {
        if (errorText(error).includes('Receiving end does not exist')) {
          throw new Error('Reload the page to enable annotation, or open it in the PDF viewer.');
        }
        throw error;
      }
    },
    highlight:(threads:Thread[],focus?:string) => send<string[]>(view,
      view.pdf?'wc-pdf-highlights':'wc-html-highlights',{threads,focus}),
    openAsPdf:view.pdf ? undefined : () => void chrome.tabs.update(view.id,{url:`${viewer}?url=${encodeURIComponent(view.source)}`}),
  }),[view]);
  return <DocumentPanel store={store} pageLink={id=>origin+'/p/'+id} view={page}/>;
}

createRoot(document.getElementById('app')!).render(<ExtensionAccount>{account=><Workspace {...account}/>}</ExtensionAccount>);
