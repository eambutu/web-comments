const tabKey=(id:number)=>'wc-inline-tab:'+id;
const inlineMenu='wc-use-inline';
const panelMenu='wc-use-panel';

function pageOrigin(url?:string) {
  return url && /^https?:\/\//i.test(url) ? new URL(url).origin : null;
}

async function activate(tab:chrome.tabs.Tab,toggle:boolean) {
  const origin=pageOrigin(tab.url);
  if (!tab.id || !origin || /\.pdf$/i.test(new URL(tab.url!).pathname)) {
    if (tab.id) await chrome.sidePanel.open({tabId:tab.id});
    return;
  }
  const key=tabKey(tab.id);
  const active=!toggle || (await chrome.storage.session.get(key))[key]!==origin;
  if (active) await chrome.storage.session.set({[key]:origin});
  else await chrome.storage.session.remove(key);
  try {
    await chrome.tabs.sendMessage(tab.id,{type:'wc-inline-active',active},{frameId:0});
  } catch {
    await chrome.action.setTitle({tabId:tab.id,title:'Reload this page to enable Web Comments'});
  }
}

export function registerInlineAction() {
  const updateBehavior=(inline:boolean)=>chrome.sidePanel.setPanelBehavior({openPanelOnActionClick:!inline});
  void chrome.storage.local.get('wcInlineAction').then(value=>updateBehavior(value.wcInlineAction===true));
  chrome.runtime.onInstalled.addListener(async ()=>{
    const inline=(await chrome.storage.local.get('wcInlineAction')).wcInlineAction===true;
    await chrome.contextMenus.removeAll();
    chrome.contextMenus.create({id:inlineMenu,title:'Use in-page comments',type:'radio',contexts:['action'],checked:inline});
    chrome.contextMenus.create({id:panelMenu,title:'Use Chrome side panel',type:'radio',contexts:['action'],checked:!inline});
  });
  chrome.contextMenus.onClicked.addListener(async (info,tab)=>{
    if (info.menuItemId!==inlineMenu && info.menuItemId!==panelMenu) return;
    const inline=info.menuItemId===inlineMenu;
    if (inline && tab?.windowId!==undefined) void chrome.sidePanel.close?.({windowId:tab.windowId}).catch(()=>{});
    if (!inline && tab?.id) {
      void chrome.sidePanel.open({tabId:tab.id}).catch(()=>{});
      await chrome.storage.session.remove(tabKey(tab.id));
      void chrome.tabs.sendMessage(tab.id,{type:'wc-inline-active',active:false},{frameId:0}).catch(()=>{});
    }
    await chrome.storage.local.set({wcInlineAction:inline});
    await updateBehavior(inline);
    if (inline && tab) await activate(tab,false);
  });
  chrome.action.onClicked.addListener(tab=>{
    void chrome.storage.local.get('wcInlineAction').then(value=>{if (value.wcInlineAction) return activate(tab,true);});
  });
  chrome.commands.onCommand.addListener((command,tab)=>{
    if (command==='toggle-in-page' && tab) void activate(tab,true);
  });
  chrome.tabs.onRemoved.addListener(id=>{void chrome.storage.session.remove(tabKey(id));});
  chrome.runtime.onMessage.addListener((message,sender,respond)=>{
    if (!sender.tab?.id || sender.frameId!==0 || !pageOrigin(sender.url)) return;
    const id=sender.tab.id,key=tabKey(id);
    if (message?.type==='wc-inline-open-panel') {
      // Opening the native panel must begin in the same user gesture as the click.
      void chrome.sidePanel.open({tabId:id}).then(async()=>{
        await chrome.storage.session.remove(key);
        await chrome.tabs.sendMessage(id,{type:'wc-inline-active',active:false},{frameId:0});
        respond(true);
      }).catch(()=>respond(false));
      return true;
    }
    if (message?.type!=='wc-inline-restore') return;
    void chrome.storage.session.get(key).then(value=>respond(value[key]===pageOrigin(sender.url)));
    return true;
  });
}
