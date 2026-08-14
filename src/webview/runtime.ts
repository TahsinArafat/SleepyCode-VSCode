export function getWebviewRuntime(markUri: string, gitTracked: boolean): string {
  return String.raw`  const vscode=acquireVsCodeApi(),messages=document.getElementById('messages'),input=document.getElementById('input'),send=document.getElementById('send'),modelDropdown=document.getElementById('modelDropdown'),modelButton=document.getElementById('modelButton'),modelMenu=document.getElementById('modelMenu'),conversationMenu=document.getElementById('conversationMenu'),conversationTitle=document.getElementById('conversationTitle'),projectIndicatorName=document.getElementById('projectIndicatorName'),projectIndicator=document.getElementById('projectIndicator'),jumpBottom=document.getElementById('jumpBottom'),queued=document.getElementById('queued'),queuedText=document.getElementById('queuedText'),plan=document.getElementById('plan'),composerBox=document.getElementById('composerBox'),attachmentRow=document.getElementById('attachmentRow'),mentionMenu=document.getElementById('mentionMenu'),composerEditBar=document.getElementById('composerEditBar'),composerEditLabel=document.getElementById('composerEditLabel'),cancelEditMessage=document.getElementById('cancelEditMessage'),slashMenu=document.getElementById('slashMenu');let runningSet=new Set(),activeConversationId='',projectIndicatorPath='',projectIndicatorFolder='No folder open',conversations=[],queuedByConversation=new Map(),currentTurn=null,current=null,activity=null,activityBody=null,reasoning=null,phaseStartedAt=0,taskCount=0,followOutput=true,gitTracked=${gitTracked},selectedModel='',modelGroups=[],liveByConversation=new Map(),attachments=[],editMessageState=null,activeConversationItems=[];
  const agentDropdown=document.getElementById('agentDropdown'),agentButton=document.getElementById('agentButton'),agentMenu=document.getElementById('agentMenu'),agentIcon=document.getElementById('agentIcon'),safetyDropdown=document.getElementById('safetyDropdown'),safetyButton=document.getElementById('safetyButton'),safetyMenu=document.getElementById('safetyMenu'),contextPanel=document.getElementById('contextPanel'),contextItems=document.getElementById('contextItems'),contextPanelMeta=document.getElementById('contextPanelMeta'),contextSummaryButton=document.getElementById('contextSummaryButton'),contextSummaryText=document.getElementById('contextSummaryText');
  const AGENTS=[
    {id:'default',name:'SleepyCode',mode:'Auto',color:'var(--vscode-charts-purple,#9333ea)',icon:'<path d="M12 3l1.9 4.1L18 9l-4.1 1.9L12 15l-1.9-4.1L6 9l4.1-1.9z"/><path d="M19 14l.9 1.9 1.9.9-1.9.9L19 19.6l-.9-1.9-1.9-.9 1.9-.9z"/><path d="M5 14l.9 1.9 1.9.9-1.9.9L5 19.6l-.9-1.9-1.9-.9 1.9-.9z"/>',desc:'General coding agent that adapts to the task.'},
    {id:'apex',name:'Apex',mode:'Build',color:'var(--vscode-charts-red,#f43f5e)',icon:'<path d="m15 12-8.5 8.5a2.12 2.12 0 0 1-3-3L12 9"/><path d="M17.64 15 22 10.64"/><path d="m20.91 11.7-1.25-1.25c-.6-.6-.93-1.4-.93-2.25v-.86L16.01 4.6a5.56 5.56 0 0 0-3.94-1.64H9l.92.82A6.18 6.18 0 0 1 12 8.4v1.56l2 2h2.47l2.26 1.91"/>',desc:'Implements production-ready features and verifies the full path.'},
    {id:'phantom',name:'Phantom',mode:'Debug',color:'var(--vscode-charts-blue,#3b82f6)',icon:'<path d="m8 2 1.88 1.88"/><path d="M14.12 3.88 16 2"/><path d="M9 7.13v-1a3.003 3.003 0 1 1 6 0v1"/><path d="M12 20c-3.3 0-6-2.7-6-6v-3a4 4 0 0 1 4-4h4a4 4 0 0 1 4 4v3c0 3.3-2.7 6-6 6"/><path d="M12 20v-9"/><path d="M6.53 9C4.6 8.8 3 7.1 3 5"/><path d="M6 13H2"/><path d="M3 21c0-2.1 1.7-3.9 3.8-4"/><path d="M20.97 5c0 2.1-1.6 3.8-3.5 4"/><path d="M22 13h-4"/><path d="M17.2 17c2.1.1 3.8 1.9 3.8 4"/>',desc:'Reproduces failures, traces root causes, and adds regression coverage.'},
    {id:'pivot',name:'Pivot',mode:'Prototype',color:'var(--vscode-charts-yellow,#eab308)',icon:'<path d="M10 2v7.527a2 2 0 0 1-.211.896L4.72 20.55a1 1 0 0 0 .9 1.45h12.76a1 1 0 0 0 .9-1.45l-5.069-10.127A2 2 0 0 1 14 9.527V2"/><path d="M8.5 2h7"/><path d="M7 16h10"/>',desc:'Builds the smallest useful implementation for fast validation.'},
    {id:'forge',name:'Forge',mode:'Review',color:'var(--vscode-charts-green,#14b8a6)',icon:'<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10"/><path d="m9 12 2 2 4-4"/>',desc:'Reviews correctness, security, regressions, and maintainability.'},
    {id:'stack',name:'Stack',mode:'Architect',color:'var(--vscode-charts-orange,#f97316)',icon:'<path d="m12 2 10 5-10 5L2 7l10-5z"/><path d="m2 17 10 5 10-5"/><path d="m2 12 10 5 10-5"/>',desc:'Designs boundaries and migrations while still shipping code.'}
  ];
  const APPROVALS=[
    {id:'ask',name:'Ask every time',desc:'Confirm edits and commands, with optional workspace-session trust for repeated non-destructive actions.'},
    {id:'edits',name:'Auto edits',desc:'Apply file edits automatically; confirm commands or trust an exact command for this workspace session.'},
    {id:'autonomous',name:'Open access',desc:'Run edits and commands without confirmation. Use only in trusted workspaces.'}
  ];
  let selectedAgentId='default';
  function findAgent(id){return AGENTS.find(a=>a.id===id)||AGENTS[0]}
  function agentIconSvg(a){return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">'+a.icon+'</svg>'}
  function syncAgentPill(){const a=findAgent(selectedAgentId);if(agentButton){agentButton.textContent=a.mode;agentButton.title=a.name+' — '+a.desc}if(agentIcon){agentIcon.style.color=a.color;agentIcon.innerHTML=agentIconSvg(a)}}
  function renderAgentMenu(){if(!agentMenu)return;agentMenu.innerHTML='';for(const a of AGENTS){const opt=document.createElement('button');opt.type='button';opt.className='dropdown-option agent-option'+(a.id===selectedAgentId?' selected':'');opt.innerHTML='<span class="agent-option-icon" style="color:'+a.color+'">'+agentIconSvg(a)+'</span><span class="agent-option-main"><span class="agent-option-name">'+esc(a.name)+' — '+esc(a.mode)+'</span><span class="agent-option-desc">'+esc(a.desc)+'</span></span>';opt.onclick=()=>selectAgent(a.id);agentMenu.appendChild(opt)}}
  function closeAgentMenu(){agentMenu?.classList.remove('open')}
  function toggleAgentMenu(){agentMenu?.classList.toggle('open');if(agentMenu?.classList.contains('open'))renderAgentMenu()}
  function selectAgent(id){selectedAgentId=id;syncAgentPill();closeAgentMenu();vscode.postMessage({type:'selectAgent',agentId:id})}
  function approvalInfo(){return APPROVALS.find(x=>x.id===document.getElementById('approvalMode')?.value)||APPROVALS[0]}
  function renderSafetyMenu(){if(!safetyMenu)return;const current=approvalInfo();safetyMenu.innerHTML=APPROVALS.map(x=>'<button type="button" class="dropdown-option safety-option'+(x.id===current.id?' selected':'')+'" data-approval="'+x.id+'"><svg class="safety-option-icon" viewBox="0 0 24 24"><path d="M12 3 5 6v5c0 4.6 2.9 8.2 7 10 4.1-1.8 7-5.4 7-10V6z" fill="none" stroke="currentColor" stroke-width="1.8"/></svg><span class="safety-option-main"><span class="safety-option-name">'+esc(x.name)+'</span><span class="safety-option-desc">'+esc(x.desc)+'</span></span></button>').join('');safetyMenu.querySelectorAll('[data-approval]').forEach(btn=>btn.onclick=()=>selectApproval(btn.dataset.approval))}
  function syncSafetyControl(){const current=approvalInfo();if(safetyButton){safetyButton.dataset.mode=current.id;safetyButton.title='Approval mode: '+current.name;safetyButton.setAttribute('aria-label','Approval mode: '+current.name)}renderSafetyMenu()}
  function selectApproval(id){const approval=document.getElementById('approvalMode');if(!approval||!APPROVALS.some(x=>x.id===id))return;approval.value=id;approval.dispatchEvent(new Event('change',{bubbles:true}));safetyMenu?.classList.remove('open');safetyButton?.setAttribute('aria-expanded','false');syncSafetyControl()}
  let editorContext={activeFile:'',hasSelection:false,selectionLines:''},includeActiveFile=true,includeSelection=true;
  let includeProjectIndex=true,projectIndexState={status:'idle',text:'Project intelligence',indexed:0,total:0,index:null},conversationQuery='';
  function renderProjectIndicator(){projectIndicatorName.textContent=editorContext.activeFile||projectIndicatorFolder;projectIndicator.title=editorContext.activeFile?'Active file: '+editorContext.activeFile:(projectIndicatorPath?'Reveal in file explorer':'Current folder in VS Code')}
  function closeContextPanel(){contextPanel?.classList.remove('open');contextPanel?.setAttribute('aria-hidden','true');contextSummaryButton?.classList.remove('active');contextSummaryButton?.setAttribute('aria-expanded','false')}
  function toggleContextPanel(){if(!contextPanel)return;const open=!contextPanel.classList.contains('open');if(open){renderContext();contextPanel.classList.add('open');contextPanel.setAttribute('aria-hidden','false');contextSummaryButton?.classList.add('active');contextSummaryButton?.setAttribute('aria-expanded','true')}else closeContextPanel()}
  function projectIndexNote(){
    if(projectIndexState.status==='indexing')return projectIndexState.text||'Indexing project…';
    if(projectIndexState.status==='ready'){const idx=projectIndexState.index||{};const bits=[];if(projectIndexState.indexed)bits.push(projectIndexState.indexed+' files indexed');if((idx.languages||[]).length)bits.push((idx.languages||[]).slice(0,2).map(x=>x.language).join(', '));if((idx.frameworks||[]).length)bits.push((idx.frameworks||[]).slice(0,3).join(', '));return bits.join(' · ')||projectIndexState.text||'Project ready'}
    if(projectIndexState.status==='error')return 'Index unavailable · click Reindex';
    return projectIndicatorPath?'Preparing local project index…':'Open a workspace to enable project intelligence';
  }
  function renderContext(){
    const hasIndex=Boolean(projectIndicatorPath);const included=(includeProjectIndex&&hasIndex?1:0)+(includeActiveFile&&editorContext.activeFile?1:0)+(includeSelection&&editorContext.hasSelection?1:0)+attachments.length;
    contextSummaryText.textContent=included?'Context '+included:'Context';contextPanelMeta.textContent=included+' item'+(included===1?'':'s')+' included';const rows=[];
    if(hasIndex)rows.push('<div class="context-item project-context-item"><button class="context-toggle'+(includeProjectIndex?' on':'')+'" type="button" data-context-toggle="project" aria-label="Toggle project intelligence"></button><svg class="context-item-icon" viewBox="0 0 24 24"><path d="M4 6h16"/><path d="M4 12h16"/><path d="M4 18h10"/></svg><div class="context-item-main"><div class="context-item-name">Project intelligence</div><div class="context-item-note">'+esc(projectIndexNote())+'</div></div><button type="button" class="context-reindex" data-reindex title="Reindex project">↻</button></div>');
    if(editorContext.activeFile)rows.push('<div class="context-item"><button class="context-toggle'+(includeActiveFile?' on':'')+'" type="button" data-context-toggle="active" aria-label="Toggle active file"></button><svg class="context-item-icon" viewBox="0 0 24 24"><path d="M6 2h9l5 5v15H6z"/><path d="M14 2v6h6"/></svg><div class="context-item-main"><div class="context-item-name" title="'+esc(editorContext.activeFile)+'">'+esc(editorContext.activeFile)+'</div><div class="context-item-note">Active file</div></div></div>');
    if(editorContext.hasSelection)rows.push('<div class="context-item"><button class="context-toggle'+(includeSelection?' on':'')+'" type="button" data-context-toggle="selection" aria-label="Toggle selection"></button><svg class="context-item-icon" viewBox="0 0 24 24"><path d="M8 3H5a2 2 0 0 0-2 2v3"/><path d="M16 3h3a2 2 0 0 1 2 2v3"/><path d="M8 21H5a2 2 0 0 1-2-2v-3"/><path d="M16 21h3a2 2 0 0 0 2-2v-3"/></svg><div class="context-item-main"><div class="context-item-name">Selected code</div><div class="context-item-note">'+esc(editorContext.selectionLines||'Current editor selection')+'</div></div></div>');
    attachments.forEach((item,index)=>{const name=item.kind==='image'?item.name:item.path;const note=item.kind==='folder'?'Folder':item.kind==='image'?'Image':'File';rows.push('<div class="context-item"><span class="context-toggle on" aria-hidden="true"></span><svg class="context-item-icon" viewBox="0 0 24 24"><path d="M6 2h9l5 5v15H6z"/><path d="M14 2v6h6"/></svg><div class="context-item-main"><div class="context-item-name" title="'+esc(name)+'">'+esc(name)+'</div><div class="context-item-note">'+note+'</div></div><button type="button" class="context-remove" data-context-remove="'+index+'" aria-label="Remove '+esc(name)+'">×</button></div>')});
    contextItems.innerHTML=rows.length?rows.join(''):'<div class="context-empty">The next request has no explicit editor context.</div>';
    contextItems.querySelectorAll('[data-context-toggle]').forEach(button=>button.onclick=()=>{if(button.dataset.contextToggle==='project')includeProjectIndex=!includeProjectIndex;else if(button.dataset.contextToggle==='active')includeActiveFile=!includeActiveFile;else includeSelection=!includeSelection;renderContext()});
    contextItems.querySelectorAll('[data-context-remove]').forEach(button=>button.onclick=()=>{attachments.splice(Number(button.dataset.contextRemove),1);renderAttachments()});
    contextItems.querySelectorAll('[data-reindex]').forEach(button=>button.onclick=e=>{e.stopPropagation();projectIndexState={status:'indexing',text:'Reindexing project…',indexed:0,total:0,index:null};renderContext();refreshEmpty();vscode.postMessage({type:'reindexProject'})});
  }
  function renderAttachments(){attachmentRow.innerHTML=attachments.map((item,index)=>{const name=item.kind==='image'?item.name:item.path;const label=item.kind==='folder'?'folder':item.kind==='image'?'image':'file';return '<span class="attachment-chip"><span class="name" title="'+esc(name)+'">'+esc(name)+'</span><span style="color:var(--vscode-descriptionForeground);font-size:10px">'+label+'</span><button type="button" data-remove-attachment="'+index+'" aria-label="Remove '+esc(name)+'">×</button></span>'}).join('');attachmentRow.querySelectorAll('[data-remove-attachment]').forEach(button=>button.onclick=()=>{attachments.splice(Number(button.dataset.removeAttachment),1);renderAttachments()});renderContext()}
  const SLASH_COMMANDS=[
    {command:'/skill',label:'Use installed skill',desc:'Run the request with an installed SKILL.md workflow.',kind:'prompt'},
    {command:'/plan',label:'Plan task',desc:'Ask SleepyCode to inspect first and produce an implementation plan before changes.',kind:'prompt'},
    {command:'/fix',label:'Fix bug',desc:'Trace the root cause, implement the fix, and verify it.',kind:'prompt'},
    {command:'/review',label:'Review code',desc:'Review correctness, security, regressions, maintainability, and tests.',kind:'prompt'},
    {command:'/test',label:'Test changes',desc:'Run the most relevant checks and fix failures caused by the current work.',kind:'prompt'},
    {command:'/explain',label:'Explain code',desc:'Explain a file, symbol, behavior, or project area using repository context.',kind:'prompt'},
    {command:'/new',label:'New chat',desc:'Start a fresh conversation.',kind:'action'},
    {command:'/settings',label:'Settings',desc:'Open SleepyCode settings.',kind:'action'},
    {command:'/usage',label:'Usage & billing',desc:'Open SleepyAI usage and billing.',kind:'action'},
    {command:'/skills',label:'Installed skills',desc:'Open the Installed tab in Skill Marketplace.',kind:'action'},
    {command:'/marketplace',label:'Skill Marketplace',desc:'Browse and install skills.',kind:'action'},
    {command:'/memory',label:'Project memory',desc:'Open durable project memory.',kind:'action'},
    {command:'/reindex',label:'Reindex project',desc:'Rebuild local repository intelligence.',kind:'action'},
    {command:'/context',label:'Context',desc:'Open the composer context manager.',kind:'action'},
    {command:'/model',label:'Model',desc:'Open the model selector.',kind:'action'},
    {command:'/agent',label:'Agent mode',desc:'Open the agent selector.',kind:'action'},
    {command:'/permissions',label:'Permissions',desc:'Open approval and autonomy controls.',kind:'action'}
  ];
  let slashResults=[],slashSelectedIndex=0;
  function closeSlashMenu(){slashMenu?.classList.remove('open');if(slashMenu)slashMenu.innerHTML='';slashSelectedIndex=0}
  function syncSlashSelection(){const options=[...slashMenu.querySelectorAll('[data-slash-index]')];options.forEach((option,index)=>option.classList.toggle('selected',index===slashSelectedIndex));options[slashSelectedIndex]?.scrollIntoView({block:'nearest'})}
  function moveSlashSelection(delta){if(!slashResults.length)return;slashSelectedIndex=(slashSelectedIndex+delta+slashResults.length)%slashResults.length;syncSlashSelection()}
  function quoteSlashSkill(name){return /\s/.test(name)?'"'+name.replace(/"/g,'\\"')+'"':name}
  function renderSlashMenu(results){slashResults=results;slashSelectedIndex=0;if(!slashMenu)return;slashMenu.innerHTML=results.map((item,index)=>'<button type="button" class="slash-option'+(index===0?' selected':'')+'" data-slash-index="'+index+'"><span class="slash-command">'+esc(item.command)+'</span><span class="slash-copy"><span class="slash-label">'+esc(item.label||'')+'</span><span class="slash-desc">'+esc(item.desc||'')+'</span></span></button>').join('');slashMenu.classList.toggle('open',results.length>0);slashMenu.querySelectorAll('[data-slash-index]').forEach(button=>button.onclick=()=>selectSlash(Number(button.dataset.slashIndex)))}
  function selectSlash(index){const item=slashResults[index];if(!item)return;if(item.skill){input.value='/skill '+quoteSlashSkill(item.skill)+' '}else{input.value=item.command+(item.kind==='prompt'?' ':'')}closeSlashMenu();input.focus();input.setSelectionRange(input.value.length,input.value.length);resize()}
  function updateSlashMenu(){const value=input.value.slice(0,input.selectionStart);if(!value.startsWith('/')){closeSlashMenu();return}const skillMatch=value.match(/^\/skill\s+(?:"([^"]*)|([^\s]*))$/i);if(skillMatch){const q=(skillMatch[1]??skillMatch[2]??'').toLowerCase();const results=installedSkills.filter(skill=>!q||String(skill.name||'').toLowerCase().includes(q)||String(skill.description||'').toLowerCase().includes(q)).slice(0,20).map(skill=>({command:'/skill '+quoteSlashSkill(skill.name),label:skill.name,desc:skill.description||'Installed skill',kind:'prompt',skill:skill.name}));renderSlashMenu(results);return}const commandMatch=value.match(/^\/([^\s]*)$/);if(!commandMatch){closeSlashMenu();return}const q=('/'+commandMatch[1]).toLowerCase();renderSlashMenu(SLASH_COMMANDS.filter(item=>item.command.toLowerCase().startsWith(q)))}
  function runDirectSlash(command){switch(command){case'/new':vscode.postMessage({type:'newConversation'});return true;case'/settings':vscode.postMessage({type:'requestSettings'});return true;case'/usage':openUsageView();vscode.postMessage({type:'requestUsage'});vscode.postMessage({type:'sleepyAccountData'});return true;case'/skills':marketplaceTab='installed';openMarketplaceView();vscode.postMessage({type:'requestMarketplaceInstalled'});return true;case'/marketplace':marketplaceTab='discover';openMarketplaceView();vscode.postMessage({type:'requestMarketplaceInstalled'});return true;case'/memory':vscode.postMessage({type:'openMemory'});return true;case'/reindex':projectIndexState={status:'indexing',text:'Reindexing project…',indexed:0,total:0,index:null};renderContext();refreshEmpty();vscode.postMessage({type:'reindexProject'});return true;case'/context':closeModelMenu();closeAgentMenu();toggleContextPanel();return true;case'/model':closeContextPanel();closeAgentMenu();toggleModelMenu();return true;case'/agent':closeContextPanel();closeModelMenu();toggleAgentMenu();return true;case'/permissions':{closeContextPanel();closeModelMenu();closeAgentMenu();const open=!safetyMenu.classList.contains('open');safetyMenu.classList.toggle('open',open);safetyButton?.setAttribute('aria-expanded',String(open));if(open)renderSafetyMenu();return true}default:return false}}
  function expandSlashPrompt(text){const trimmed=text.trim();const first=(trimmed.match(/^\/[^\s]+/)||[])[0]?.toLowerCase()||'';if(runDirectSlash(first))return{handled:true,text:''};const skill=trimmed.match(/^\/skill\s+(?:"([^"]+)"|'([^']+)'|([^\s]+))(?:\s+([\s\S]+))?$/i);if(skill){const name=skill[1]||skill[2]||skill[3]||'',task=(skill[4]||'').trim();if(!task){void showNotifyModal({title:'Use installed skill',body:'Add a task after the skill name. Example: /skill '+name+' review the authentication flow',ok:'OK'});return{handled:true,text:''}}return{handled:false,text:'The user explicitly invoked the installed skill "'+name+'" with /skill. You MUST call skillsmp_read_installed for "'+name+'" before planning, editing, or executing the task. Then follow that SKILL.md within SleepyCode safety rules.\n\nTask:\n'+task}}const arg=trimmed.replace(/^\/[^\s]+\s*/,'');if(first==='/plan')return{handled:false,text:'Inspect the relevant project context first. Create and maintain a concrete task plan before making changes.\n\nTask:\n'+arg};if(first==='/fix')return{handled:false,text:'Fix this issue by tracing the root cause, making the smallest correct change, and running relevant regression checks.\n\nIssue:\n'+arg};if(first==='/review')return{handled:false,text:'Review this scope for correctness, security, regressions, maintainability, and missing tests. Report concrete findings and fix high-confidence issues when appropriate.\n\nScope:\n'+arg};if(first==='/test')return{handled:false,text:'Run the most relevant tests/checks for this scope. Diagnose failures, fix failures caused by the current work, and report the verification result.\n\nScope:\n'+arg};if(first==='/explain')return{handled:false,text:'Explain this using precise repository context, relevant files/symbols, and execution flow. Do not modify code unless explicitly requested.\n\nTopic:\n'+arg};return{handled:false,text}}
  let mentionResults=[],mentionStart=-1,mentionSelectedIndex=0;
  function closeMentionMenu(){mentionMenu.classList.remove('open');mentionMenu.innerHTML='';mentionSelectedIndex=0}
  function syncMentionSelection(){const options=[...mentionMenu.querySelectorAll('[data-mention-index]')];options.forEach((option,index)=>option.classList.toggle('selected',index===mentionSelectedIndex));options[mentionSelectedIndex]?.scrollIntoView({block:'nearest'})}
  function moveMentionSelection(delta){if(!mentionResults.length)return;mentionSelectedIndex=(mentionSelectedIndex+delta+mentionResults.length)%mentionResults.length;syncMentionSelection()}
  function renderMentionMenu(results){mentionSelectedIndex=0;mentionMenu.innerHTML=results.map((item,index)=>'<button type="button" class="mention-option'+(index===mentionSelectedIndex?' selected':'')+'" data-mention-index="'+index+'"><span>'+esc(item.path)+'</span><span class="mention-kind">'+esc(item.kind)+'</span></button>').join('');mentionMenu.classList.toggle('open',results.length>0);mentionMenu.querySelectorAll('[data-mention-index]').forEach(button=>button.onclick=()=>selectMention(Number(button.dataset.mentionIndex)))}
  function selectMention(index){const item=mentionResults[index];if(!item||mentionStart<0)return;const cursor=input.selectionStart;input.value=input.value.slice(0,mentionStart)+'@'+item.path+' '+input.value.slice(cursor);input.selectionStart=input.selectionEnd=mentionStart+item.path.length+2;closeMentionMenu();input.focus();resize()}
  function updateMentionQuery(){const cursor=input.selectionStart;const before=input.value.slice(0,cursor);const match=before.match(/(?:^|\s)@([^\s@]*)$/);if(!match){closeMentionMenu();return}mentionStart=cursor-match[1].length-1;vscode.postMessage({type:'fileMentionQuery',query:match[1]})}
  input.addEventListener('input',()=>{resize();updateMentionQuery();updateSlashMenu()});
  input.addEventListener('keydown',event=>{if(!slashMenu?.classList.contains('open'))return;if(event.key==='ArrowDown'){event.preventDefault();event.stopImmediatePropagation();moveSlashSelection(1);return}if(event.key==='ArrowUp'){event.preventDefault();event.stopImmediatePropagation();moveSlashSelection(-1);return}if(event.key==='Enter'&&!event.shiftKey&&slashResults.length){event.preventDefault();event.stopImmediatePropagation();selectSlash(slashSelectedIndex);return}if(event.key==='Escape'){event.preventDefault();event.stopImmediatePropagation();closeSlashMenu();return}});
  input.addEventListener('keydown',event=>{if(!mentionMenu.classList.contains('open'))return;if(event.key==='ArrowDown'){event.preventDefault();event.stopImmediatePropagation();moveMentionSelection(1);return}if(event.key==='ArrowUp'){event.preventDefault();event.stopImmediatePropagation();moveMentionSelection(-1);return}if(event.key==='Enter'&&!event.shiftKey&&mentionResults.length){event.preventDefault();event.stopImmediatePropagation();selectMention(mentionSelectedIndex);return}if(event.key==='Escape'){event.preventDefault();event.stopImmediatePropagation();closeMentionMenu();return}});
  composerBox.addEventListener('dragover',event=>{event.preventDefault();composerBox.classList.add('drag-over')});composerBox.addEventListener('dragleave',()=>composerBox.classList.remove('drag-over'));composerBox.addEventListener('drop',event=>{event.preventDefault();composerBox.classList.remove('drag-over');const paths=[...event.dataTransfer.files].map(file=>file.path).filter(Boolean);if(paths.length)vscode.postMessage({type:'dropFiles',paths})});
  input.addEventListener('paste',event=>{const file=[...event.clipboardData.files].find(item=>item.type.startsWith('image/'));if(!file)return;event.preventDefault();const reader=new FileReader();reader.onload=()=>vscode.postMessage({type:'pasteImage',dataUrl:String(reader.result),mimeType:file.type,name:file.name||'pasted-image',size:file.size});reader.readAsDataURL(file)});
  const attachButton=document.getElementById('attachButton');
  attachButton?.addEventListener('click',()=>vscode.postMessage({type:'requestFilePicker'}));

  const esc=s=>String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const notifyBackdrop=document.getElementById('notifyBackdrop'),notifyModal=document.getElementById('notifyModal'),notifyTitle=document.getElementById('notifyTitle'),notifyBody=document.getElementById('notifyBody'),notifyIcon=document.getElementById('notifyIcon'),notifyRisk=document.getElementById('notifyRisk'),notifyOk=document.getElementById('notifyOk'),notifyCancel=document.getElementById('notifyCancel'),notifySecondary=document.getElementById('notifySecondary'),notifyClose=document.getElementById('notifyClose');let notifyQueue=[],notifyBusy=false;
  function showNotifyModal(opts){return new Promise(resolve=>{notifyQueue.push({opts,resolve});drainNotify()})}
  function drainNotify(){if(notifyBusy||!notifyQueue.length)return;notifyBusy=true;const job=notifyQueue.shift(),opts=job.opts;notifyTitle.textContent=opts.title||'SleepyCode';notifyBody.textContent=opts.body||'';notifyModal.classList.toggle('danger',Boolean(opts.danger));notifyIcon.style.display=opts.icon===false?'none':'';const risk=opts.risk||'';notifyRisk.textContent=risk==='high'?'High risk':risk==='medium'?'Review required':risk==='low'?'Low risk':'';notifyRisk.className='notify-risk'+(risk?' '+risk:'');notifyRisk.style.display=risk?'':'none';notifyOk.textContent=opts.ok||'OK';notifyOk.classList.toggle('danger',Boolean(opts.danger));notifyCancel.textContent=opts.cancel||'Cancel';notifyCancel.style.display=opts.cancel?'':'none';notifySecondary.textContent=opts.secondary||'';notifySecondary.style.display=opts.secondary?'':'none';notifyBackdrop.classList.add('open');setTimeout(()=>{(opts.cancel!==false?notifyCancel:notifyOk).focus()},0);window.__resolveNotify=(choice)=>{notifyBusy=false;notifyBackdrop.classList.remove('open');job.resolve(choice);drainNotify()}}
  notifyOk.onclick=()=>{if(window.__resolveNotify)window.__resolveNotify('ok')};notifyCancel.onclick=()=>{if(window.__resolveNotify)window.__resolveNotify('cancel')};notifySecondary.onclick=()=>{if(window.__resolveNotify)window.__resolveNotify('secondary')};notifyClose.onclick=()=>{if(window.__resolveNotify)window.__resolveNotify('cancel')};notifyBackdrop.onclick=e=>{if(e.target===notifyBackdrop&&window.__resolveNotify)window.__resolveNotify('cancel')};document.addEventListener('keydown',e=>{if(e.key==='Escape'&&window.__resolveNotify)window.__resolveNotify('cancel')});
  const displayModel=s=>String(s||'').toLowerCase();
  const modelIdOf=m=>typeof m==='object'&&m?m.id:String(m||'');
  const modelNameOf=m=>typeof m==='object'&&m?m.name||m.id:String(m||'');
  const modelA2Z=(a,b)=>modelNameOf(a).localeCompare(modelNameOf(b),undefined,{sensitivity:'base',numeric:true})||modelIdOf(a).localeCompare(modelIdOf(b),undefined,{sensitivity:'base',numeric:true});
  function findModelName(id){
    for(const group of modelGroups){
      for(const m of group.models||[]){
        if(modelIdOf(m)===id)return modelNameOf(m);
      }
    }
    return displayModel(id);
  }
  function providerOfModel(id){
    for(const g of modelGroups){
      for(const m of g.models||[]){
        if(modelIdOf(m)===id)return g.providerId;
      }
    }
    return '';
  }
  function sessionMoney(n){if(n===undefined||n===null||!Number.isFinite(Number(n)))return'—';const v=Number(n);if(v>=1)return'$'+Number(v.toFixed(2));if(v>=0.01)return'$'+Number(v.toFixed(3));if(v===0)return'$0.0000';return'$'+Number(v.toPrecision(2))}
  function sessionMetrics(){
    let inTok=0, outTok=0;
    for(const item of activeConversationItems){
      if(item.inputTokens||item.outputTokens){
        inTok+=item.inputTokens||0;
        outTok+=item.outputTokens||0;
      }
    }
    const live=liveRuns.get(activeConversationId);
    if(live){inTok+=live.input||0;outTok+=live.output||0}
    let effectiveModel=selectedModel||'';
    let providerId=providerOfModel(effectiveModel);
    let ctxLimit=0;
    if(effectiveModel){
      // Auto inherits the context window of the first-party model SleepyAI would route to.
      for(const g of modelGroups){
        const selected=(g.models||[]).find(m=>modelIdOf(m)===effectiveModel);
        if(g.providerId==='sleepyai'&&typeof selected==='object'&&selected&&selected.isAuto){
          const concrete=(g.models||[]).filter(m=>!(typeof m==='object'&&m&&m.isAuto));
          const routed=concrete.find(m=>typeof m==='object'&&m&&m.recommended)||concrete[0];
          if(routed)effectiveModel=modelIdOf(routed);
        }
      }
      // First check model groups for context window from provider.
      for(const g of modelGroups){
        for(const m of g.models||[]){
          const mid=typeof m==='object'&&m?m.id:String(m||'');
          if(mid===effectiveModel){
            ctxLimit=(m.contextWindow)||0;
            break;
          }
        }
        if(ctxLimit)break;
      }
      // Fallback to sleepy model prices
      if(!ctxLimit){
        for(const p of sleepyModelPrices){
          if(p.modelId===effectiveModel||p.name===effectiveModel){ctxLimit=p.contextWindow||0;break}
        }
      }
      if(!ctxLimit){
        const low=effectiveModel.toLowerCase();
        if(low.includes('256k')||low.includes('quick')||low.includes('deepseek')||low.includes('mimo')||low.includes('macaron'))ctxLimit=256000;
        else if(low.includes('flash')||low.includes('gemini')||low.includes('pro'))ctxLimit=1000000;
        else ctxLimit=128000;
      }
    }
    let cost=null;
    if(providerId==='sleepyai'){
      const p=sleepyModelPrices.find(x=>x.modelId===effectiveModel||x.name===effectiveModel);
      if(p&&p.inputPrice!==undefined&&p.outputPrice!==undefined){
        const inputCost=inTok*(p.inputPrice/1e6);
        const outputCost=outTok*(p.outputPrice/1e6);
        cost={input:inputCost,output:outputCost,total:inputCost+outputCost};
      }
    }
    return {inTok,outTok,total:inTok+outTok,ctxLimit,effectiveModel,providerId,cost};
  }
  function updateSessionStats(){
    const statContext=document.getElementById('statContext');
    const statTokens=document.getElementById('statTokens');
    const statPerf=document.getElementById('statPerf');
    const statSpeed=document.getElementById('statSpeed');
    const statCost=document.getElementById('statCost');
    const statGroup=document.getElementById('statPillGroup');
    if(!statContext||!statTokens)return;
    const s=sessionMetrics();
    const live=liveRuns.get(activeConversationId);
    const showStats=s.total>0||Boolean(s.effectiveModel)||Boolean(live)||(statGroup&&statGroup.classList.contains('active'));
    if(statGroup)statGroup.classList.toggle('show',showStats);
    const ctxLabel=s.ctxLimit>0?fmt(s.ctxLimit):'128k';
    statContext.textContent=fmt(s.total)+' / '+ctxLabel;
    statTokens.textContent='⬆ '+fmt(s.inTok)+'  ⬇ '+fmt(s.outTok);
    if(s.cost&&statCost){
      statCost.textContent=sessionMoney(s.cost.total);
      statCost.style.display='inline-flex';
      statCost.title='Estimated session cost ('+sessionMoney(s.cost.input)+' in / '+sessionMoney(s.cost.output)+' out)';
    }else if(statCost){statCost.style.display='none'}
    if(live&&live.speed&&statPerf&&statSpeed){statPerf.style.display='inline-flex';statSpeed.textContent=live.speed+' tok/s'}else if(statPerf){statPerf.style.display='none'}
    const sessionInfo=document.getElementById('sessionInfo');
    if(sessionInfo&&sessionInfo.classList.contains('open'))renderSessionInfo();
  }
  function renderSessionInfo(){
    const sessionInfo=document.getElementById('sessionInfo');
    if(!sessionInfo)return;
    const s=sessionMetrics();
    const ctxLabel=s.ctxLimit>0?fmt(s.ctxLimit):'128k';
    const pct=s.ctxLimit>0?Math.min(100,Math.round((s.total/s.ctxLimit)*100)):0;
    const barColor=pct>=80?'danger':pct>=50?'warn':'safe';
    const modelLabel=s.effectiveModel||'No model selected';
    const costHtml=s.cost
      ?'<div class="session-info-cell"><div class="k">Est. cost</div><div class="v">'+esc(sessionMoney(s.cost.total))+'</div></div><div class="session-info-cell"><div class="k">In / out cost</div><div class="v">'+esc(sessionMoney(s.cost.input))+' / '+esc(sessionMoney(s.cost.output))+'</div></div>'
      :'<div class="session-info-cell"><div class="k">Est. cost</div><div class="v">'+esc(s.providerId==='sleepyai'?'Sign in for pricing':'Not available')+'</div></div>';
    sessionInfo.innerHTML='<div class="session-info-head"><span class="session-info-model" title="'+esc(modelLabel)+'">'+esc(modelLabel)+'</span><button type="button" class="session-info-close" id="sessionInfoClose" aria-label="Close session info">×</button></div><div class="session-info-grid"><div class="session-info-cell"><div class="k">Input tokens</div><div class="v">'+esc(fmt(s.inTok))+'</div></div><div class="session-info-cell"><div class="k">Output tokens</div><div class="v">'+esc(fmt(s.outTok))+'</div></div><div class="session-info-cell"><div class="k">Total tokens</div><div class="v">'+esc(fmt(s.total))+'</div></div><div class="session-info-cell"><div class="k">Context window</div><div class="v">'+esc(ctxLabel)+'</div></div>'+costHtml+'</div><div class="session-info-bar"><div class="bar-head"><span>Context used</span><span class="v">'+esc(fmt(s.total))+' / '+esc(ctxLabel)+'</span></div><div class="limit-bar-track"><div class="limit-bar-fill '+barColor+'" style="width:'+pct+'%"></div></div><div class="limit-bar-pct">'+pct+'% of context window</div></div>';
    const close=sessionInfo.querySelector('#sessionInfoClose');
    if(close)close.onclick=()=>toggleSessionInfo(false);
  }
  function toggleSessionInfo(force){
    const sessionInfo=document.getElementById('sessionInfo');
    const statPillGroup=document.getElementById('statPillGroup');
    if(!sessionInfo)return;
    const open=force===undefined?!sessionInfo.classList.contains('open'):force;
    if(open){renderSessionInfo();sessionInfo.classList.add('open');sessionInfo.setAttribute('aria-hidden','false');statPillGroup?.classList.add('active')}
    else{sessionInfo.classList.remove('open');sessionInfo.setAttribute('aria-hidden','true');statPillGroup?.classList.remove('active')}
  }
  const usageView=document.getElementById('usageView'),usageContent=document.getElementById('usageContent'),usageBilling=document.getElementById('usageBilling'),usageActivity=document.getElementById('usageActivity'),usageNav=document.getElementById('usageNav');  let usageData=null,liveRuns=new Map(),usageTimer=null,usagePeriod='today',sleepyModelPrices=[];
  const marketplaceView=document.getElementById('marketplaceView'),marketplaceNav=document.getElementById('marketplaceNav'),marketplaceSearchEl=document.getElementById('marketplaceSearch'),marketplaceDiscover=document.getElementById('marketplaceDiscover'),marketplaceInstalledPane=document.getElementById('marketplaceInstalledPane'),marketplaceResults=document.getElementById('marketplaceResults'),marketplaceInstalledEl=document.getElementById('marketplaceInstalled'),marketplaceStatus=document.getElementById('marketplaceStatus'),marketplaceQuery=document.getElementById('marketplaceQuery'),marketplaceRepo=document.getElementById('marketplaceRepo'),marketplaceSort=document.getElementById('marketplaceSort'),previewModal=document.getElementById('previewModal'),previewContent=document.getElementById('previewContent'),previewInstall=document.getElementById('previewInstall'),previewProgress=document.getElementById('previewProgress'),previewProgressFill=document.getElementById('previewProgressFill'),previewProgressLabel=document.getElementById('previewProgressLabel');let installedSkills=[],marketplaceCards=[],marketplaceActions=[],marketplaceBusy=false,previewState=null,marketplaceTab='discover',marketplaceTopLoaded=false,marketplaceHeading='Popular skills',marketplaceHint='Search above to discover more skills.',installSeq=0,marketplaceDebounce=0,marketplaceInstalling={};
  function marketplaceStatusText(text,ok){marketplaceStatus.textContent=text||'';marketplaceStatus.className='marketplace-status'+(ok?' ok':ok===false?' bad':'')}
  function installedMatch(author,name){const rawName=String(name||'');const n=rawName.toLowerCase();const normName=n.replace(/\s+/g,'-').replace(/[^a-z0-9._-]/g,'');const authorKey=String(author||'').toLowerCase().replace(/^(https?:\/\/)?(www\.)?github\.com\//i,'').replace(/\/+$/,'');const aParts=authorKey.split('/').filter(Boolean);const aUser=aParts[0]||'';const aRepo=aParts[1]||'';return installedSkills.some(x=>{const xName=String(x.name||'').toLowerCase();if(x.source){const s=String(x.source).toLowerCase().replace(/\/+$/,'');const sParts=s.split('/').filter(Boolean);if(sParts[0]===aUser&&(!aRepo||sParts[1]===aRepo)&&xName===n)return true;return false}return x.folder===normName||xName===n})}
  function renderMarketplaceNav(){marketplaceNav.innerHTML=[['discover','Discover'],['installed','Installed'+(installedSkills.length?' ('+installedSkills.length+')':'')]].map(([id,label])=>'<button class="period-pill'+(id===marketplaceTab?' active':'')+'" data-tab="'+id+'">'+label+'</button>').join('');marketplaceNav.querySelectorAll('.period-pill').forEach(btn=>{btn.onclick=()=>selectMarketplaceTab(btn.dataset.tab)})}
  function selectMarketplaceTab(tab){if(!tab)return;marketplaceTab=tab;renderMarketplaceNav();marketplaceSearchEl.classList.toggle('hidden',marketplaceTab==='installed');marketplaceDiscover.classList.toggle('active',marketplaceTab==='discover');marketplaceInstalledPane.classList.toggle('active',marketplaceTab==='installed');if(marketplaceTab==='installed')vscode.postMessage({type:'requestMarketplaceInstalled'})}
  function renderInstalledSkills(){renderMarketplaceNav();if(!installedSkills.length){marketplaceInstalledEl.innerHTML='<div class="marketplace-empty">No skills yet.<br>Find one in Discover, install it, then use it from this tab or ask SleepyCode by name.</div>';return}marketplaceInstalledEl.innerHTML='<div class="installed-rows">'+installedSkills.map(x=>'<div class="installed-row" title="'+esc(x.skillMdPath)+'"><div class="installed-row-body"><div class="installed-row-name">'+esc(x.name)+'</div>'+(x.description?'<div class="installed-row-desc">'+esc(x.description)+'</div>':'')+'<div class="installed-row-src">'+(x.source?'from '+esc(x.source):'')+'</div><div class="installed-row-path" data-reveal="'+esc(x.folder)+'" title="Reveal in file explorer"><svg viewBox="0 0 24 24"><path d="M4 20h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.7-.9L9.6 3.9A2 2 0 0 0 7.9 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"/></svg><span>'+esc(x.skillMdPath)+'</span></div></div><div class="installed-row-actions"><button type="button" class="installed-row-use" data-use-skill="'+esc(x.name)+'" title="Use '+esc(x.name)+' in the composer">Use</button><button class="installed-row-remove" data-uninstall="'+esc(x.folder)+'" title="Uninstall '+esc(x.name)+'"><svg viewBox="0 0 24 24"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg></button></div></div>').join('')+'</div>';marketplaceInstalledEl.querySelectorAll('[data-use-skill]').forEach(btn=>{btn.onclick=e=>{e.stopPropagation();const name=btn.dataset.useSkill||'skill',existing=input.value.trim();closeMarketplaceView();input.value=existing?'Use the "'+name+'" skill for this request:\n\n'+input.value:'Use the "'+name+'" skill to ';resize();input.focus();input.setSelectionRange(input.value.length,input.value.length)}});marketplaceInstalledEl.querySelectorAll('[data-uninstall]').forEach(btn=>{btn.onclick=e=>{e.stopPropagation();vscode.postMessage({type:'marketplaceUninstall',folder:btn.dataset.uninstall})}});marketplaceInstalledEl.querySelectorAll('[data-reveal]').forEach(el=>{el.onclick=()=>vscode.postMessage({type:'revealSkill',folder:el.dataset.reveal})})}
  function installingForCard(cardKey){for(const key in marketplaceInstalling){const st=marketplaceInstalling[key];if(st&&st.cardKey&&st.cardKey===cardKey)return st}return null}
  function progressPct(st){const total=(st&&st.total)||0;return total>0?Math.min(100,Math.round(((st&&st.done)||0)/total*100)):6}
  function renderMarketplaceResults(){if(marketplaceBusy){marketplaceResults.innerHTML='<div class="marketplace-empty"><span class="spinner"></span></div>';return}if(!marketplaceCards.length){marketplaceResults.innerHTML='<div class="marketplace-empty">Search the marketplace or browse a GitHub repo to find skills to install.</div>';return}marketplaceResults.innerHTML='<div class="marketplace-section-head"><div class="marketplace-section-title">'+esc(marketplaceHeading)+'</div>'+(marketplaceHint?'<div class="marketplace-section-hint">'+esc(marketplaceHint)+'</div>':'')+'</div><div class="skill-list">'+marketplaceCards.map((card,index)=>{const installed=installedMatch(card.author,card.name);const installing=installingForCard(card.key||'');let actions='';if(installing){actions='<div class="skill-progress"><div class="skill-progress-bar"><div class="skill-progress-fill" style="width:'+progressPct(installing)+'%"></div></div><div class="skill-progress-label">'+esc(installing.label)+'</div></div>'}else{actions=installed?'<span class="skill-installed-badge">Installed</span>':((marketplaceActions[index]&&marketplaceActions[index].preview?'<button class="small-btn" data-skill-action="'+index+'" data-action="preview">Preview</button>':'')+(marketplaceActions[index]&&marketplaceActions[index].install?'<button class="primary" data-skill-action="'+index+'" data-action="install">Install</button>':''))}return '<div class="skill-card" data-key="'+esc(card.key||'')+'"><div class="skill-card-head"><span class="skill-card-name" title="'+esc(card.name)+'">'+esc(card.name)+'</span><span class="skill-card-meta">'+card.meta+'</span></div>'+(card.description?'<p class="skill-card-desc">'+esc(card.description)+'</p>':'')+'<div class="skill-card-actions">'+actions+'</div></div>'}).join('')+'</div><div class="marketplace-results-footer">Retrieved from SkillsMP</div>';marketplaceResults.querySelectorAll('[data-skill-action]').forEach(btn=>{btn.onclick=()=>skillAction(Number(btn.dataset.skillAction),btn.dataset.action)})}
  function skillAction(index,action){const entry=marketplaceActions[index];if(!entry||!entry[action])return;if(action==='preview'){openSkillPreview(entry.preview.source,entry.preview.path||'',null,index);return}if(action==='install'){startSkillInstall(index)}}
  function startSkillInstall(index,override){const entry=override||marketplaceActions[index];if(!entry||!entry.install)return;const key='inst-'+(++installSeq);const cardKey=(index>=0&&marketplaceCards[index])?marketplaceCards[index].key:((previewState&&previewState.cardKey)||'');marketplaceInstalling[key]={cardKey,done:0,total:0,label:'Installing…'};if(override&&previewState)previewState.key=key;renderMarketplaceResults();updatePreviewProgress(key);vscode.postMessage({type:'marketplaceInstall',source:entry.install.source,skill:entry.install.skill,key})}
  function updateCardProgress(key){const st=marketplaceInstalling[key];if(!st||!st.cardKey)return;const cardEl=marketplaceResults.querySelector('.skill-card[data-key="'+CSS.escape(st.cardKey)+'"]');if(!cardEl)return;const fill=cardEl.querySelector('.skill-progress-fill');const label=cardEl.querySelector('.skill-progress-label');if(fill)fill.style.width=progressPct(st)+'%';if(label)label.textContent=st.label||'Installing…'}
  function updatePreviewProgress(key){const st=marketplaceInstalling[key];const active=Boolean(previewState&&previewState.key===key&&previewModal.classList.contains('open'));previewProgress.classList.toggle('visible',active&&Boolean(st));previewProgress.classList.toggle('error',active&&Boolean(st&&st.error));if(!active||!st)return;previewProgressFill.style.width=progressPct(st)+'%';previewProgressLabel.textContent=st.label||'Installing…'}
  function openSkillPreview(source,path,title,origin){previewState={source,path,origin,cardKey:(origin>=0&&marketplaceCards[origin])?marketplaceCards[origin].key:'',key:''};previewModal.classList.add('open');previewContent.textContent='Loading…';previewInstall.style.display='none';previewProgress.classList.remove('visible','error');document.getElementById('previewTitle').textContent=title||'Skill preview';vscode.postMessage({type:'marketplacePreview',source,path:path||undefined})}
  function closeSkillPreview(){previewModal.classList.remove('open');previewState=null;previewProgress.classList.remove('visible','error')}
  function loadMarketplaceTop(force,sortBy){if(marketplaceTopLoaded&&!force)return;marketplaceTopLoaded=true;marketplaceHeading='Popular skills';marketplaceHint='Search above to discover more skills.';marketplaceBusy=true;marketplaceCards=[];marketplaceActions=[];marketplaceStatusText('');renderMarketplaceResults();vscode.postMessage({type:'marketplaceTop',sortBy:sortBy||'stars'})}
  function openMarketplaceView(){document.querySelector('.app').style.display='none';marketplaceView.classList.add('visible');renderInstalledSkills();selectMarketplaceTab(marketplaceTab);renderMarketplaceResults();if(!marketplaceCards.length)loadMarketplaceTop()}
  function closeMarketplaceView(){marketplaceView.classList.remove('visible');document.querySelector('.app').style.display='flex'}
  function marketplaceSearch(){const query=marketplaceQuery.value.trim();if(!query)return;marketplaceTopLoaded=true;marketplaceHeading='Search results';marketplaceHint='Try another search to explore more.';marketplaceBusy=true;marketplaceCards=[];marketplaceActions=[];marketplaceStatusText('');renderMarketplaceResults();vscode.postMessage({type:'marketplaceSearch',query,limit:12,sortBy:marketplaceSort.value})}
  function runMarketplaceSearch(live){const run=()=>{const q=marketplaceQuery.value.trim();q?marketplaceSearch():loadMarketplaceTop(true,marketplaceSort.value)};if(!live){run();return}clearTimeout(marketplaceDebounce);marketplaceDebounce=setTimeout(run,300)}
  function marketplaceListRepo(){const source=marketplaceRepo.value.trim();if(!source)return;marketplaceTopLoaded=true;marketplaceHeading='Skills in '+source;marketplaceHint='Preview a skill before installing it.';marketplaceBusy=true;marketplaceCards=[];marketplaceActions=[];marketplaceStatusText('');renderMarketplaceResults();vscode.postMessage({type:'marketplaceListRepo',source})}
  const USAGE_PERIODS=[['today','Today'],['yesterday','Yesterday'],['week','7 days'],['month','30 days']];
  const zeroTokens=()=>({input:0,output:0});
  const trimNum=s=>s.replace(/\.?0+$/,'');
  const fmt=n=>{n=n||0;if(n>=1000000)return trimNum((n/1000000).toFixed(2))+'M';if(n>=1000)return trimNum((n/1000).toFixed(1))+'k';return String(n)};
  const tokenText=t=>'<span class="tokens" title="'+t.input.toLocaleString()+' input · '+t.output.toLocaleString()+' output">'+(t.input?fmt(t.input):'0')+'<span class="sep">/</span>'+(t.output?fmt(t.output):'0')+'</span>';
  function renderUsage(){
    const data=usageData||{models:[],totals:{}};
    const models=data.models||[],totals=data.totals||{};
    let live={input:0,output:0};
    for(const v of liveRuns.values()){live.input+=v.input||0;live.output+=v.output||0}
    usageNav.innerHTML=USAGE_PERIODS.map(([id,label])=>'<button class="period-pill'+(id===usagePeriod?' active':'')+'" data-period="'+id+'">'+label+'</button>').join('');
    usageNav.querySelectorAll('.period-pill').forEach(btn=>{btn.onclick=()=>{usagePeriod=btn.dataset.period;renderUsage()}});

    const money=n=>n===undefined||n===null?'—':'$'+Number(n).toFixed(2);
    const compactTokens=n=>{n=Number(n)||0;if(n>=1000000)return trimNum((n/1000000).toFixed(1))+'M';if(n>=1000)return trimNum((n/1000).toFixed(1))+'k';return String(n)};
    const account=sleepyAccount||{loggedIn:false};
    if(!account.loggedIn){
      usageBilling.innerHTML='<div class="billing-overview"><div class="billing-card billing-login"><div><div class="billing-plan">SleepyAI account</div><p>Sign in to see your plan, balance, spending limits, and server-authoritative usage.</p></div><div class="billing-actions"><button class="primary" id="usageSignIn">Sign in to SleepyAI</button></div></div></div>';
      const signIn=document.getElementById('usageSignIn');if(signIn)signIn.onclick=()=>vscode.postMessage({type:'sleepyLogin'});
    }else{
      const sub=account.subscription||{},bal=account.balances||{},lim=account.limits||{};
      const plan=sub.plan||account.tier||'SleepyAI';
      const status=sub.status||'active';
      const monthlySpend=sub.monthlySpend!==undefined?sub.monthlySpend:lim.costMonthly;
      const monthlyLimit=sub.monthlyLimit!==undefined?sub.monthlyLimit:lim.limitMonthly;
      const monthlyPct=monthlySpend!==undefined&&monthlyLimit?Math.min(100,Math.max(0,Math.round((monthlySpend/monthlyLimit)*100))):null;
      const dailyTokenText=lim.usedTokensToday!==undefined&&lim.tokensPerDay!==undefined?compactTokens(lim.usedTokensToday)+' / '+compactTokens(lim.tokensPerDay):'—';
      const daySpend=lim.cost24h!==undefined?money(lim.cost24h):'—';
      let html='<div class="billing-overview"><div class="billing-card"><div class="billing-account-head"><div class="billing-account-main"><div class="billing-plan">'+esc(plan)+'</div><div class="billing-account-sub">'+esc(account.email||'Signed in to SleepyAI')+'</div></div><span class="billing-badge">'+esc(status)+'</span></div><div class="billing-actions"><button class="primary" id="usageManagePlan">Manage plan</button><button class="secondary" id="usageAccountRefresh">Refresh account</button></div></div>';
      html+='<div class="billing-card"><div class="billing-metrics"><div class="billing-metric"><div class="billing-metric-label">Available balance</div><div class="billing-metric-value">'+money(bal.credits)+'</div></div><div class="billing-metric"><div class="billing-metric-label">This month</div><div class="billing-metric-value">'+money(monthlySpend)+'</div></div><div class="billing-metric"><div class="billing-metric-label">Last 24h</div><div class="billing-metric-value">'+daySpend+'</div></div><div class="billing-metric"><div class="billing-metric-label">Free tokens today</div><div class="billing-metric-value">'+dailyTokenText+'</div></div></div>';
      if(monthlyPct!==null){html+='<div class="billing-progress"><div class="billing-progress-head"><span>Monthly allowance</span><span>'+money(monthlySpend)+' / '+money(monthlyLimit)+'</span></div><div class="limit-bar-track"><div class="limit-bar-fill '+(monthlyPct>=80?'danger':monthlyPct>=50?'warn':'safe')+'" style="width:'+monthlyPct+'%"></div></div><div class="limit-bar-pct">'+monthlyPct+'% used</div></div>'}
      html+='</div></div>';
      usageBilling.innerHTML=html;
      const manage=document.getElementById('usageManagePlan');if(manage)manage.onclick=()=>vscode.postMessage({type:'openSleepyDashboard'});
      const refresh=document.getElementById('usageAccountRefresh');if(refresh)refresh.onclick=()=>vscode.postMessage({type:'sleepyAccountData'});
    }

    const hasUsage=models.length>0||live.input>0||live.output>0;
    if(!hasUsage){usageActivity.innerHTML='<div class="usage-local-note">No local model activity recorded yet. This section tracks requests from this VS Code installation; SleepyAI billing above is the authoritative account view.</div><div class="usage-empty" style="height:auto;min-height:120px">No requests recorded for this period.</div>';return}
    const liveByModel=new Map();
    for(const v of liveRuns.values()){if(!v.input&&!v.output)continue;const key=(v.model||'')+'|'+(v.provider||'');const e=liveByModel.get(key)||{model:v.model,provider:v.provider,input:0,output:0};e.input+=v.input||0;e.output+=v.output||0;liveByModel.set(key,e)}
    const rows=[];
    const seen=new Set();
    for(const m of models){
      const key=m.model+'|'+(m.provider||'');
      seen.add(key);
      const base=(m.periods&&m.periods[usagePeriod])||zeroTokens();
      const l=usagePeriod==='today'?liveByModel.get(key):undefined;
      const tokens={input:base.input+(l?l.input:0),output:base.output+(l?l.output:0)};
      const speed=m.avgTokensPerSecond?m.avgTokensPerSecond:undefined;
      const priceInfo=m.provider==='sleepyai'?sleepyModelPrices.find(p=>p.modelId===m.model||p.name===m.model):undefined;
      const cost=priceInfo&&priceInfo.inputPrice!==undefined&&priceInfo.outputPrice!==undefined?{input:priceInfo.inputPrice,output:priceInfo.outputPrice}:undefined;
      if(tokens.input||tokens.output)rows.push({model:m.model,provider:m.provider||'',tokens,speed,cost});
    }
    for(const [key,v] of liveByModel){if(seen.has(key))continue;rows.push({model:v.model,provider:v.provider||'',tokens:{input:v.input,output:v.output}})}
    rows.sort((a,b)=>(b.tokens.input+b.tokens.output)-(a.tokens.input+a.tokens.output)||a.model.localeCompare(b.model));
    const total=usagePeriod==='today'?{input:(totals.today&&totals.today.input||0)+live.input,output:(totals.today&&totals.today.output||0)+live.output}:(totals[usagePeriod]||zeroTokens());
    const fmtPrice=n=>{if(n===undefined||n===null)return'';if(n>=1)return'$'+n.toFixed(2)+'/M';if(n>=0.001)return'$'+n.toFixed(3)+'/M';return'$'+n.toFixed(4)+'/M'};
    const rowHtml=r=>{
      let costHtml='';
      if(r.cost){const parts=[];if(r.cost.input!==undefined)parts.push('in '+fmtPrice(r.cost.input));if(r.cost.output!==undefined)parts.push('out '+fmtPrice(r.cost.output));if(parts.length)costHtml=' <span style="opacity:.72">('+parts.join(', ')+')</span>'}
      return'<div class="usage-row"><div class="usage-model"><div class="model-id" title="'+esc(r.model)+'">'+esc(displayModel(r.model))+'</div><div class="provider">'+esc(r.provider)+(r.speed?' &bull; '+r.speed+' tok/s':'')+costHtml+'</div></div>'+tokenText(r.tokens)+'</div>';
    };
    let summaryExtra='';
    if(data.overallAvgTokensPerSecond){summaryExtra='<div class="provider" style="margin-top:2px">Avg speed: '+data.overallAvgTokensPerSecond+' tok/s ('+(data.totalRequests||0)+' requests)</div>'}
    usageActivity.innerHTML='<div class="usage-local-note">Local token counts are diagnostic and may differ from billed usage because routing, caching, and server-side accounting are handled by SleepyAI.</div><div class="usage-list">'+rows.map(rowHtml).join('')+'<div class="usage-row total"><div class="usage-model"><div class="model-id">All models</div><div class="provider">input / output</div>'+summaryExtra+'</div>'+tokenText(total)+'</div></div>';
  }
  function openUsageView(){document.querySelector('.app').style.display='none';usageView.classList.add('visible');renderUsage();vscode.postMessage({type:'requestUsage'});vscode.postMessage({type:'sleepyAccountData'});clearInterval(usageTimer);usageTimer=setInterval(()=>vscode.postMessage({type:'requestUsage'}),5000)}
  function closeUsageView(){usageView.classList.remove('visible');document.querySelector('.app').style.display='flex';clearInterval(usageTimer);usageTimer=null}
  const nearBottom=()=>messages.scrollHeight-messages.scrollTop-messages.clientHeight<42;
  const isRunning=()=>runningSet.has(activeConversationId);
  function updateJump(){const away=!nearBottom();jumpBottom.style.bottom=(document.querySelector('.composer').offsetHeight+10)+'px';jumpBottom.classList.toggle('visible',away);jumpBottom.classList.toggle('working',away&&isRunning())}
  function syncSendButton(){const r=isRunning();send.classList.toggle('loading',r);send.classList.toggle('stop',r);const sSvg=send.querySelector('.send-svg'),xSvg=send.querySelector('.stop-svg');if(sSvg)sSvg.style.display=r?'none':'';if(xSvg)xSvg.style.display=r?'block':'none';document.querySelector('.box')?.classList.toggle('working',r)}
  function ensureOptimisticActivity(){if(isRunning()&&!activity&&currentTurn){try{createActivity();const st=activity&&activity.querySelector('.activity-status');if(st)st.textContent='Working…'}catch(e){}}}
  const pinScroll=()=>{if(followOutput)messages.scrollTop=messages.scrollHeight};
  const scroll=(force=false)=>{if(force||followOutput)pinScroll();updateJump();requestAnimationFrame(()=>{if(followOutput)pinScroll();updateJump()})};
  function scrollActivity(){const body=activityBody,details=activity;requestAnimationFrame(()=>{if(body&&details?.open&&followOutput)body.scrollTop=body.scrollHeight});scroll()}
  function freshLive(){return{userItem:null,phase:'thinking',plan:null,currentRaw:'',errorText:null,errorRetry:false,activity:null,closedActivities:[]}}
  function liveState(convId){let s=liveByConversation.get(convId);if(!s){s=freshLive();liveByConversation.set(convId,s)}return s}
  function ensureLiveActivity(s){if(!s.activity)s.activity={loading:true,open:true,summary:'Thinking',reasoningParts:[''],tasks:[],subagents:[],retries:[],changed:[],phaseStartedAt:Date.now(),taskCount:0,closed:false}}
  function closeLiveActivity(s){const a=s.activity;if(!a||a.closed)return;a.closed=true;a.loading=false;a.open=false;const seconds=Math.max(1,Math.round((Date.now()-a.phaseStartedAt)/1000));a.summary='Worked for '+seconds+'s'+(a.taskCount?' · '+a.taskCount+' task'+(a.taskCount===1?'':'s'):'');s.closedActivities.push(a);s.activity=null}
  function liveActivityContent(a){return Boolean(a&&(a.reasoningParts.some(p=>p)||a.tasks.length||(a.subagents||[]).length||a.retries.length||a.changed.length))}
  function buildLiveActivity(a){const d=document.createElement('details');d.className='activity'+(a.loading?' loading':'')+(liveActivityContent(a)?' has-content':'');d.open=a.open;if(a.loading&&!liveActivityContent(a)){d.innerHTML='<summary><span class="activity-spinner" aria-hidden="true"></span><span class="activity-status">'+esc(a.summary||'Thinking…')+'</span><button class="activity-stop-btn" type="button" title="Stop running" aria-label="Stop running"><svg viewBox="0 0 24 24"><rect x="6" y="6" width="12" height="12" rx="2"/></svg>Stop</button></summary><div class="activity-body"></div>'}else{d.innerHTML='<summary>'+esc(a.summary||'Thinking…')+'</summary><div class="activity-body"></div>'}const body=d.querySelector('.activity-body');for(const part of a.reasoningParts||[]){const r=document.createElement('div');r.className='reasoning';r.dataset.raw=part;r.innerHTML=markdown(part);body.appendChild(r)}for(const t of (a.tasks||[]).filter(t=>!t.parentId)){const row=document.createElement('div');row.className='tool'+(t.done?' done':'')+(t.failed?' failed':'');row.dataset.task=t.id;row.innerHTML='<span class="task-state"></span><div class="task-label">'+markdown(t.name)+'</div>';body.appendChild(row)}for(const sub of a.subagents||[]){const group=document.createElement('details');group.className='subagent-group'+(sub.done?' done':'')+(sub.ok===false?' failed':'');group.dataset.subagent=sub.id;group.open=!sub.done;group.innerHTML='<summary class="subagent-summary"><span class="subagent-icon">&#9654;</span><span class="subagent-label">'+esc(sub.name||('Subagent ('+(sub.role||'worker')+')'))+'</span><span class="subagent-state">'+(sub.done?(sub.ok===false?'Failed':'Done'):'Running')+'</span></summary><div class="subagent-body"></div>';const subBody=group.querySelector('.subagent-body');for(const t of (a.tasks||[]).filter(t=>t.parentId===sub.id)){const row=document.createElement('div');row.className='tool'+(t.done?' done':'')+(t.failed?' failed':'');row.dataset.task=t.id;row.innerHTML='<span class="task-state"></span><div class="task-label">'+markdown(t.name)+'</div>';subBody.appendChild(row)}if(sub.done&&sub.result){const result=document.createElement('div');result.className='subagent-result';result.textContent=sub.result;subBody.appendChild(result)}if(sub.done&&sub.error){const err=document.createElement('div');err.className='subagent-result error';err.textContent=sub.error;subBody.appendChild(err)}body.appendChild(group)}for(const ret of a.retries||[]){const row=document.createElement('div');row.className='tool retry'+(ret.ok?' done':(ret.ok===false?' failed':''));row.dataset.retry=String(ret.attempt);const retLabel='**Reconnecting '+ret.attempt+'/'+ret.max+'**'+(ret.error?' — '+esc(ret.error):'');row.innerHTML='<span class="task-state"></span><div class="task-label">'+markdown(retLabel)+'</div>';body.appendChild(row)}for(const c of a.changed||[]){const cd=document.createElement('div');cd.className='changed';cd.textContent=c.text;cd.onclick=()=>vscode.postMessage({type:'openFile',path:c.path});body.appendChild(cd)}return d}
  function renderLive(convId){const s=liveByConversation.get(convId);if(!s)return;const turn=document.querySelector('.turn:last-child');if(!turn)return;currentTurn=turn;if(s.plan)showPlan(s.plan);if(s.errorText){const d=document.createElement('div');d.className='error';d.textContent=s.errorText;if(s.errorRetry)d.appendChild(errorActions());turn.appendChild(d)}for(const closed of s.closedActivities||[])turn.appendChild(buildLiveActivity(closed));if(s.currentRaw){current=document.createElement('div');current.className='assistant streaming';current.dataset.raw=s.currentRaw;current.innerHTML=markdown(s.currentRaw);turn.appendChild(current)}if(s.activity&&liveActivityContent(s.activity)){const d=buildLiveActivity(s.activity);turn.appendChild(d);activity=d;activityBody=d.querySelector('.activity-body');const rs=d.querySelectorAll('.reasoning');reasoning=rs.length?rs[rs.length-1]:null;const stopBtn=activity.querySelector('.activity-stop-btn');if(stopBtn)stopBtn.onclick=e=>{e.preventDefault();e.stopPropagation();vscode.postMessage({type:'stop'})}}else if(s.activity&&s.activity.loading){const d=buildLiveActivity(s.activity);turn.appendChild(d);activity=d;activityBody=d.querySelector('.activity-body');const stopBtn=activity.querySelector('.activity-stop-btn');if(stopBtn)stopBtn.onclick=e=>{e.preventDefault();e.stopPropagation();vscode.postMessage({type:'stop'})}}phaseStartedAt=s.activity?.phaseStartedAt||Date.now();taskCount=s.activity?.taskCount||0;followOutput=true;scroll(true)}
  function updateQueuedVisibility(){const prompt=queuedByConversation.get(activeConversationId)||null;const show=Boolean(prompt);queued.classList.toggle('visible',show);queuedText.textContent=show?prompt:'';document.getElementById('steerQueued').style.display=show&&runningSet.has(activeConversationId)?'':'none';updateJump()}
  function inlineMarkdown(raw){const tick=String.fromCharCode(96),tokenStart=String.fromCharCode(57344),tokenEnd=String.fromCharCode(57345),codes=[];let line=esc(raw);line=line.replace(new RegExp(tick+'([^'+tick+'\\n]+)'+tick,'g'),(_,code)=>{codes.push(code);return tokenStart+(codes.length-1)+tokenEnd});line=line.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g,'<a href="$2">$1</a>').replace(/\*\*([^*]+)\*\*/g,'<strong>$1</strong>').replace(/__([^_]+)__/g,'<strong>$1</strong>').replace(/\*([^*]+)\*/g,'<em>$1</em>').replace(/_([^_]+)_/g,'<em>$1</em>');return line.replace(new RegExp(tokenStart+'(\\d+)'+tokenEnd,'g'),(_,index)=>'<code>'+codes[Number(index)]+'</code>')}
  function markdown(raw){
    const fence=String.fromCharCode(96).repeat(3),lines=String(raw).split(/\r?\n/);let html='',inCode=false,code='',list='',paragraph=[],table=[];
    const flushParagraph=()=>{if(paragraph.length){html+='<p>'+paragraph.map(inlineMarkdown).join(' ')+'</p>';paragraph=[]}};
    const closeList=()=>{if(list){html+='</'+list+'>';list=''}};
    const isSep=r=>r.every(c=>/^:?-{1,}:?$/.test(c));
    const flushTable=()=>{if(!table.length)return;const rows=table.filter(r=>!isSep(r));if(rows.length){html+='<table>';rows.forEach((r,i)=>{const tag=i?'td':'th';html+='<tr>'+r.map(c=>'<'+tag+'>'+inlineMarkdown(c)+'</'+tag+'>').join('')+'</tr>'});html+='</table>'}table=[]};
    for(const rawLine of lines){
      if(rawLine.trim().startsWith(fence)){flushParagraph();closeList();flushTable();if(inCode){html+='<pre><code>'+esc(code.replace(/\n$/,''))+'</code></pre>';code=''}inCode=!inCode;continue}
      if(inCode){code+=rawLine+'\n';continue}
      const trow=rawLine.match(/^\s*\|(.*)\|\s*$/);if(trow&&trow[1].includes('|')){if(!table.length){flushParagraph();closeList()}table.push(trow[1].split('|').map(c=>c.trim()));continue}
      if(table.length)flushTable();
      const item=rawLine.match(/^\s*([-+*]|\d+\.)\s+(.+)$/);if(item){flushParagraph();const type=/\d/.test(item[1])?'ol':'ul';if(list!==type){closeList();html+='<'+type+'>';list=type}html+='<li>'+inlineMarkdown(item[2])+'</li>';continue}
      closeList();if(!rawLine.trim()){flushParagraph();continue}
      const heading=rawLine.match(/^(#{1,3})\s+(.+)$/);if(heading){flushParagraph();const level=heading[1].length;html+='<h'+level+'>'+inlineMarkdown(heading[2])+'</h'+level+'>';continue}
      const quote=rawLine.match(/^>\s?(.*)$/);if(quote){flushParagraph();html+='<blockquote>'+inlineMarkdown(quote[1])+'</blockquote>';continue}
      paragraph.push(rawLine.trim())
    }
    flushParagraph();closeList();flushTable();if(inCode)html+='<pre><code>'+esc(code.replace(/\n$/,''))+'</code></pre>';return html
  }
  const STARTERS=[
    {title:'Build a feature',desc:'Plan, implement, and verify a production-ready change.',prompt:'Build this feature. Inspect the codebase first, make a concise implementation plan, implement it completely, and verify the result:\n\n'},
    {title:'Fix a bug',desc:'Reproduce the failure and fix the root cause.',prompt:'Fix this bug. Reproduce or trace the failure, identify the root cause, implement the smallest correct fix, and add regression coverage where appropriate:\n\n'},
    {title:'Review code',desc:'Find concrete correctness, security, and regression risks.',prompt:'Review the current project and recent changes for correctness, security, regressions, maintainability, and missing tests. Prioritize concrete findings and fix high-confidence issues.'},
    {title:'Understand project',desc:'Map architecture, execution paths, and key files.',prompt:'Inspect this project and explain its architecture, main execution paths, important modules, and the safest places to make changes. Keep the explanation practical and reference file paths.'}
  ];
  const emptyState=()=>{const recent=conversations.filter(x=>!x.archived&&x.hasMessages).slice(0,5);const account=sleepyAccount&&sleepyAccount.loggedIn?('<div class="empty-account">SleepyAI'+(sleepyAccount.tier?' · '+esc(sleepyAccount.tier):'')+'</div>'):'';const project=projectIndicatorFolder&&projectIndicatorFolder!=='No folder open'?'<div class="empty-project">Workspace <strong title="'+esc(projectIndicatorFolder)+'">'+esc(projectIndicatorFolder)+'</strong></div>':'';const indexCard=projectIndicatorPath?'<button type="button" class="project-index-card '+esc(projectIndexState.status)+'" data-reindex-project><span class="project-index-dot"></span><span class="project-index-main"><span class="project-index-title">Project intelligence</span><span class="project-index-copy">'+esc(projectIndexNote())+'</span></span><span class="project-index-action">'+(projectIndexState.status==='indexing'?'Indexing…':'Reindex')+'</span></button>':'';return '<div class="empty" id="empty"><div class="empty-inner"><img class="empty-mark" src="${markUri}" alt=""><h2>What are we working on?</h2><p class="empty-subtitle">SleepyAI is ready to build, debug, review, or explain this workspace.</p>'+project+account+indexCard+'<div class="starter-grid">'+STARTERS.map((x,index)=>'<button type="button" class="starter-card" data-starter="'+index+'"><span class="starter-title">'+esc(x.title)+'</span><span class="starter-desc">'+esc(x.desc)+'</span></button>').join('')+'</div>'+(recent.length?'<div class="recent"><div class="recent-head"><span>Recent conversations</span><span class="count">'+recent.length+'</span></div><div class="recent-list">'+recent.map(x=>'<div class="recent-item" data-open-recent="'+esc(x.id)+'" title="'+esc(x.title)+'">'+(x.pinned?'<span class="recent-pin">★</span>':'')+(x.running?'<span class="spinner"></span>':'')+'<span class="title">'+esc(x.title)+'</span>'+(x.changeCount?'<span class="recent-change">'+x.changeCount+' files</span>':'')+'<span class="time">'+recentTimeLabel(x.updatedAt)+'</span><button class="archive-action" data-archive-recent="'+esc(x.id)+'" title="Archive" aria-label="Archive '+esc(x.title)+'"><svg viewBox="0 0 24 24"><rect width="20" height="5" x="2" y="3" rx="1"/><path d="M4 8v11a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8"/><path d="M10 12h4"/></svg></button></div>').join('')+'</div></div>':'')+'</div></div>'};
  function bindRecent(scope){scope.querySelectorAll('[data-open-recent]').forEach(el=>el.onclick=()=>vscode.postMessage({type:'openConversation',id:el.dataset.openRecent}));scope.querySelectorAll('[data-archive-recent]').forEach(el=>el.onclick=e=>{e.stopPropagation();vscode.postMessage({type:'archiveConversation',id:el.dataset.archiveRecent})});scope.querySelectorAll('[data-starter]').forEach(el=>el.onclick=()=>{const starter=STARTERS[Number(el.dataset.starter)];if(!starter)return;input.value=starter.prompt;resize();input.focus();input.setSelectionRange(input.value.length,input.value.length)});scope.querySelectorAll('[data-reindex-project]').forEach(el=>el.onclick=()=>{projectIndexState={status:'indexing',text:'Reindexing project…',indexed:0,total:0,index:null};refreshEmpty();renderContext();vscode.postMessage({type:'reindexProject'})})}
  function refreshEmpty(){const el=document.getElementById('empty');if(!el)return;el.outerHTML=emptyState();const empty=document.getElementById('empty');if(empty)bindRecent(empty)}
  const timeLabel=value=>new Date(value||Date.now()).toLocaleTimeString([],{hour:'numeric',minute:'2-digit'});
  const recentTimeLabel=value=>new Date(value||Date.now()).toLocaleString([],{month:'short',day:'numeric',hour:'numeric',minute:'2-digit'});
  function setEditBar(open,item){if(!composerEditBar)return;composerEditBar.classList.toggle('visible',Boolean(open));if(composerEditLabel&&item)composerEditLabel.textContent='Editing message · resending from this point'+(item.attachments?.length?' · '+item.attachments.length+' attachment'+(item.attachments.length===1?'':'s'):'')}
  function clearMessageEdit(restoreDraft){const state=editMessageState;if(!state)return;editMessageState=null;setEditBar(false);if(restoreDraft){input.value=state.draftText;attachments=state.draftAttachments;includeProjectIndex=state.draftContext.includeProjectIndex;includeActiveFile=state.draftContext.includeActiveFile;includeSelection=state.draftContext.includeSelection;renderAttachments();resize()}closeMentionMenu();closeSlashMenu()}
  function startMessageEdit(item){if(isRunning())return;if(editMessageState)clearMessageEdit(true);editMessageState={conversationId:activeConversationId,itemId:item.id,draftText:input.value,draftAttachments:[...attachments],draftContext:{includeProjectIndex,includeActiveFile,includeSelection}};input.value=item.text||'';attachments=(item.attachments||[]).map(attachment=>({...attachment}));renderAttachments();setEditBar(true,item);resize();input.focus();input.setSelectionRange(input.value.length,input.value.length)}
  if(cancelEditMessage)cancelEditMessage.onclick=()=>{clearMessageEdit(true);input.focus()};
  function messageFooter(item,isAssistant){
    const footer=document.createElement('div');
    footer.className='message-footer'+(isAssistant?' assistant-footer':'');
    const time=document.createElement('span');
    time.textContent=timeLabel(item.timestamp);
    footer.appendChild(time);
    const copy=document.createElement('button');
    copy.className='message-action';
    copy.title='Copy';
    copy.setAttribute('aria-label','Copy message');
    copy.innerHTML='<svg viewBox="0 0 24 24"><rect width="14" height="14" x="8" y="8" rx="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/></svg>';
    copy.onclick=()=>vscode.postMessage({type:'copyText',text:item.text});
    footer.appendChild(copy);
    const branch=document.createElement('button');
    branch.className='message-action';
    branch.title='Branch to new chat';
    branch.setAttribute('aria-label','Branch to new chat');
    branch.innerHTML='<svg viewBox="0 0 24 24"><line x1="6" y1="3" x2="6" y2="15"/><circle cx="18" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><path d="M18 9a9 9 0 0 1-9 9"/></svg>';
    branch.onclick=()=>vscode.postMessage({type:'branchConversation',conversationId:activeConversationId,itemId:item.id});
    footer.appendChild(branch);
    if(!isAssistant){
      const editBtn=document.createElement('button');
      editBtn.className='message-action';
      editBtn.title='Edit and resend from this message';
      editBtn.setAttribute('aria-label','Edit and resend from this message');
      editBtn.innerHTML='<svg viewBox="0 0 24 24"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg>';
      editBtn.onclick=()=>startMessageEdit(item);
      footer.appendChild(editBtn);
    }
    if(isAssistant&&gitTracked&&item.gitTree){
      const restore=document.createElement('button');
      restore.className='message-action';
      restore.title='Restore checkpoint';
      restore.setAttribute('aria-label','Restore checkpoint');
      restore.innerHTML='<svg viewBox="0 0 24 24"><path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/></svg>';
      restore.onclick=async()=>{
        const choice=await showNotifyModal({title:'Restore Checkpoint?',body:'This will restore your Git workspace files and conversation state to this response. All later messages will be removed.',ok:'Restore Checkpoint',cancel:'Cancel',danger:true});
        if(choice==='ok'){
          vscode.postMessage({type:'restoreCheckpoint',conversationId:activeConversationId,itemId:item.id});
        }
      };
      footer.appendChild(restore);
    }
    return footer;
  }
  function iterationPauseCard(item,actionable=true){
    if(!item||!item.paused)return null;
    const limit=Number(item.pauseLimit)||50;
    const card=document.createElement('div');
    card.className='iteration-paused';
    card.innerHTML='<div class="iteration-paused-copy"><strong>Iteration paused</strong><span>Reached the '+limit+'-step limit with work still in progress.</span></div>'+(actionable?'<button type="button" class="iteration-continue">Continue iteration</button>':'');
    const btn=card.querySelector('.iteration-continue');
    if(btn)btn.onclick=()=>{btn.disabled=true;btn.textContent='Continuing…';vscode.postMessage({type:'continueIteration',conversationId:activeConversationId,itemId:item.id})};
    return card;
  }
  function changesCard(item){
    const changes=(item&&item.changes)||[];if(!changes.length)return null;const card=document.createElement('section');card.className='changes-card';
    const remaining=changes.filter(x=>!x.reverted),staged=remaining.filter(x=>x.staged).length;const changedLabel=remaining.length+' active / '+changes.length+' total';
    card.innerHTML='<div class="changes-head"><span class="changes-status">✓</span><span class="changes-title">Task changes</span><span class="changes-count">'+changedLabel+'</span></div>'+(item.commitHash?'<div class="changes-commit"><span>Committed</span><strong>'+esc(item.commitHash)+'</strong><span>'+esc(item.commitMessage||'')+'</span></div>':'')+'<div class="changes-list"></div><div class="changes-actions"><button type="button" class="secondary" data-review-changes>Source Control</button>'+(gitTracked&&item.gitTree&&!item.commitHash&&remaining.length?'<button type="button" class="secondary" data-stage-changes>'+(staged===remaining.length?'Staged':'Stage all')+'</button><button type="button" class="primary-lite" data-commit-changes>Commit</button><button type="button" class="danger-lite" data-undo-changes>Restore checkpoint</button>':'')+'</div>';
    const list=card.querySelector('.changes-list');
    for(const change of changes){const row=document.createElement('div');row.className='change-row-wrap'+(change.reverted?' reverted':'');row.innerHTML='<button type="button" class="change-row" data-open-change><span class="change-action">'+esc(change.reverted?'Reverted':(change.staged?'Staged':(change.action||'Modified')))+'</span><span class="change-path">'+esc(change.path)+'</span></button><span class="change-row-actions">'+(gitTracked&&item.gitTree?'<button type="button" class="change-mini" data-diff title="Review diff">Diff</button>':'')+(gitTracked&&item.gitTree&&!item.commitHash&&!change.reverted?'<button type="button" class="change-mini danger" data-revert title="Revert this file">Revert</button>':'')+'</span>';
      const open=row.querySelector('[data-open-change]');if(open){open.disabled=change.action==='Deleted'||change.reverted;open.onclick=()=>{if(!open.disabled)vscode.postMessage({type:'openFile',path:change.path})}};
      const diff=row.querySelector('[data-diff]');if(diff)diff.onclick=()=>vscode.postMessage({type:'gitReviewFile',conversationId:activeConversationId,itemId:item.id,path:change.path});
      const revert=row.querySelector('[data-revert]');if(revert)revert.onclick=()=>vscode.postMessage({type:'gitRevertFile',conversationId:activeConversationId,itemId:item.id,path:change.path});
      list.appendChild(row)}
    const review=card.querySelector('[data-review-changes]');if(review)review.onclick=()=>vscode.postMessage({type:'reviewChanges',conversationId:activeConversationId,itemId:item.id});
    const stage=card.querySelector('[data-stage-changes]');if(stage)stage.onclick=()=>vscode.postMessage({type:'gitStageChanges',conversationId:activeConversationId,itemId:item.id});
    const commit=card.querySelector('[data-commit-changes]');if(commit)commit.onclick=()=>vscode.postMessage({type:'gitCommit',conversationId:activeConversationId,itemId:item.id});
    const restore=card.querySelector('[data-undo-changes]');if(restore)restore.onclick=async()=>{const choice=await showNotifyModal({title:'Restore this task checkpoint?',body:'Workspace files will return to the state captured before this response. If this is an older response, later conversation messages will also be removed.',ok:'Restore checkpoint',cancel:'Cancel',danger:true});if(choice==='ok')vscode.postMessage({type:'restoreCheckpoint',conversationId:activeConversationId,itemId:item.id})};return card
  }
  function userBubble(item){const row=document.createElement('div');row.className='user-row';const wrapper=document.createElement('div');wrapper.className='user-message';const text=document.createElement('div');text.className='user-text';text.textContent=item.text;wrapper.append(text);for(const attachment of (item.attachments||[])){if(attachment.kind==='image'&&attachment.previewDataUrl){const image=document.createElement('img');image.className='user-image-attachment';image.src=attachment.previewDataUrl;image.alt=attachment.name||'Attached image';image.title=attachment.name||'Attached image';wrapper.append(image)}else if(attachment.kind!=='image'){const chip=document.createElement('div');chip.className='user-attachment';chip.textContent=(attachment.kind==='folder'?'📁 ':'📄 ')+attachment.path;wrapper.append(chip)}}wrapper.append(messageFooter(item,false));row.appendChild(wrapper);return row}
  function closeCurrentText(){if(current)current.classList.remove('streaming');current=null}
  function clearActivityRefs(){activity=activityBody=reasoning=null;taskCount=0}
  function createActivity(){closeCurrentText();activity=document.createElement('details');activity.className='activity loading';activity.open=true;activity.innerHTML='<summary><span class="activity-spinner" aria-hidden="true"></span><span class="activity-status">Thinking…</span><button class="activity-stop-btn" type="button" title="Stop running" aria-label="Stop running"><svg viewBox="0 0 24 24"><rect x="6" y="6" width="12" height="12" rx="2"/></svg>Stop</button></summary><div class="activity-body"></div>';activityBody=activity.querySelector('.activity-body');reasoning=document.createElement('div');reasoning.className='reasoning';reasoning.dataset.raw='';activityBody.appendChild(reasoning);const stopBtn=activity.querySelector('.activity-stop-btn');if(stopBtn)stopBtn.onclick=e=>{e.preventDefault();e.stopPropagation();vscode.postMessage({type:'stop'})};currentTurn.appendChild(activity);phaseStartedAt=Date.now();taskCount=0}
  function ensureActivity(){if(!activity)createActivity();syncSendButton()}
  function createTextSegment(){if(activity){finishActivity();clearActivityRefs()}current=document.createElement('div');current.className='assistant streaming';current.dataset.raw='';currentTurn.appendChild(current);return current}
  function planCard(title,steps,activeStep,doneSteps,interrupted){const d=document.createElement('div');d.className='plan';const doneSet=new Set(doneSteps||[]),list=steps||[],doneCount=list.filter((_,index)=>doneSet.has(index)).length,total=list.length,percent=total?Math.min(100,Math.round(doneCount/total*100)):0;const head=document.createElement('div');head.className='plan-head';const h=document.createElement('div');h.className='plan-title';h.textContent=title||'Plan';head.appendChild(h);if(total){const count=document.createElement('span');count.className='plan-count';count.textContent=doneCount+' / '+total;head.appendChild(count)}if(interrupted){const badge=document.createElement('span');badge.className='plan-badge';badge.textContent='Interrupted';head.appendChild(badge)}const dismiss=document.createElement('button');dismiss.className='plan-dismiss';dismiss.title='Dismiss plan';dismiss.setAttribute('aria-label','Dismiss plan');dismiss.textContent='×';dismiss.onclick=()=>{if(plan&&plan.contains(d))hidePlan();else d.remove()};head.appendChild(dismiss);d.appendChild(head);if(total){const progress=document.createElement('div');progress.className='plan-progress';progress.innerHTML='<span class="plan-progress-fill" style="width:'+percent+'%"></span>';d.appendChild(progress);const currentLabel=list[activeStep];if(currentLabel&&!doneSet.has(activeStep)){const currentStep=document.createElement('div');currentStep.className='plan-current';currentStep.textContent=(interrupted?'Paused: ':'Working: ')+currentLabel;d.appendChild(currentStep)}const ol=document.createElement('ol');ol.className='plan-steps';list.forEach((s,index)=>{const isDone=doneSet.has(index);const isActive=index===activeStep&&!isDone&&!interrupted;const isPaused=index===activeStep&&!isDone&&interrupted;const li=document.createElement('li');li.className='plan-step'+(isDone?' done':'')+(isActive?' active':'')+(isPaused?' paused':'');const state=document.createElement('span');state.className='plan-state';state.textContent=isDone?'✓':(isPaused?'⏸':'');const label=document.createElement('span');label.className='plan-label';label.textContent=s;li.append(state,label);ol.appendChild(li)});d.appendChild(ol)}return d}
  function showPlan(m){plan.classList.add('visible');plan.classList.toggle('done',Boolean(m.done));plan.classList.toggle('interrupted',Boolean(m.interrupted));plan.innerHTML='';plan.appendChild(planCard(m.title,m.steps,m.activeStep,m.doneSteps,Boolean(m.interrupted)));scroll()}
  function hidePlan(){plan.classList.remove('visible')}
  function beginTurn(item){document.getElementById('empty')?.remove();currentTurn=document.createElement('section');currentTurn.className='turn';currentTurn.appendChild(userBubble(item));messages.appendChild(currentTurn);current=activity=activityBody=reasoning=null;scroll(true)}
  function workActivity(item){const d=document.createElement('details');d.className='activity has-content';const tasks=(item.work||[]).filter(w=>w.kind==='task');const seconds=Math.max(1,Math.round(item.seconds||1));d.innerHTML='<summary>Worked for '+seconds+'s'+(tasks.length?' · '+tasks.length+' task'+(tasks.length===1?'':'s'):'')+'</summary><div class="activity-body"></div>';const body=d.querySelector('.activity-body');for(const w of item.work||[]){if(w.kind==='plan')continue;if(w.kind==='reasoning'){const r=document.createElement('div');r.className='reasoning';r.innerHTML=markdown(w.text);body.appendChild(r)}else{const row=document.createElement('div');row.className='tool'+(w.done===false?'':' done');row.innerHTML='<span class="task-state"></span><div class="task-label">'+markdown(w.text)+'</div>';body.appendChild(row)}}return d}
  function runErrorAction(action){
    if(action==='retry'){vscode.postMessage({type:'retryMessage',conversationId:activeConversationId});return}
    if(action==='signin'){vscode.postMessage({type:'sleepyLogin'});return}
    if(action==='account'){vscode.postMessage({type:'openSleepyDashboard'});return}
    if(action==='settings'){vscode.postMessage({type:'requestSettings'});return}
    if(action==='models'){closeContextPanel();if(!modelMenu.classList.contains('open'))toggleModelMenu();modelButton.focus();return}
    if(action==='context'){if(!contextPanel.classList.contains('open'))toggleContextPanel();contextSummaryButton.focus()}
  }
  function structuredErrorCard(item){
    const info=item&&item.errorInfo;
    if(!info){const fallback=document.createElement('div');fallback.className='assistant error-card';fallback.textContent=item&&item.text?item.text:'Request failed.';fallback.appendChild(errorActions());return fallback}
    const card=document.createElement('div');card.className='assistant error-card structured-error error-'+(info.code||'unknown');
    const head=document.createElement('div');head.className='error-head';head.innerHTML='<span class="error-symbol">!</span><div class="error-copy"><div class="error-title">'+esc(info.title||'Request failed')+'</div></div>';card.appendChild(head);
    const body=document.createElement('div');body.className='error-message';body.textContent=info.message||item.text||'Request failed.';card.appendChild(body);
    const actions=document.createElement('div');actions.className='error-actions';
    const add=(action,label,primary)=>{if(!action||!label)return;const btn=document.createElement('button');btn.type='button';btn.className='error-action'+(primary?' primary':'');btn.textContent=label;btn.onclick=()=>runErrorAction(action);actions.appendChild(btn)};
    add(info.primaryAction,info.primaryLabel,true);add(info.secondaryAction,info.secondaryLabel,false);
    if(!actions.childElementCount&&info.retryable)add('retry','Retry',true);
    if(actions.childElementCount)card.appendChild(actions);
    return card
  }
  function renderConversation(items){messages.innerHTML=items&&items.length?'':emptyState();hidePlan();currentTurn=current=activity=activityBody=reasoning=null;bindRecent(messages);for(let i=0;i<(items||[]).length;i++){const item=items[i];if(item.role==='user'){const turn=document.createElement('section');turn.className='turn';turn.appendChild(userBubble(item));const next=items[i+1];if(next&&next.role==='assistant'){for(const p of (next.work||[]).filter(w=>w.kind==='plan')){const steps=p.steps||[];const allDone=(p.doneSteps||[]).length>=steps.length&&steps.length>0;turn.appendChild(planCard(p.title||'Plan',steps,allDone?-1:(p.activeStep??-1),p.doneSteps||[],Boolean(p.interrupted)))}if(next.work&&next.work.length)turn.appendChild(workActivity(next));turn.appendChild(next.kind==='error'?structuredErrorCard(next):(()=>{const answer=document.createElement('div');answer.className='assistant';answer.innerHTML=markdown(next.text);return answer})());const pauseNotice=iterationPauseCard(next,i+1===items.length-1);if(pauseNotice)turn.appendChild(pauseNotice);const changeSummary=changesCard(next);if(changeSummary)turn.appendChild(changeSummary);turn.appendChild(messageFooter(next,true));i++}messages.appendChild(turn)}}followOutput=true;scroll(true)}
  function enableActivity(){if(activity)activity.classList.add('has-content')}
  function ensureSubagentGroup(m){
    ensureActivity();enableActivity();
    let group=activityBody.querySelector('[data-subagent="'+CSS.escape(m.id)+'"]');
    if(!group){
      group=document.createElement('details');group.className='subagent-group';group.dataset.subagent=m.id;group.open=true;
      group.innerHTML='<summary class="subagent-summary"><span class="subagent-icon">&#9654;</span><span class="subagent-label"></span><span class="subagent-state">Running</span></summary><div class="subagent-body"></div>';
      activityBody.appendChild(group)
    }
    const label=group.querySelector('.subagent-label');if(label&&m.name)label.textContent=m.name;else if(label&&!label.textContent)label.textContent='Subagent ('+(m.role||'worker')+')';
    return group
  }
  function updateSubagent(m){
    const group=ensureSubagentGroup(m);const state=group.querySelector('.subagent-state');
    if(m.phase==='end'){group.classList.add('done');group.classList.toggle('failed',m.ok===false);group.open=m.ok===false;if(state)state.textContent=m.ok===false?'Failed':'Done';const body=group.querySelector('.subagent-body');if(body&&(m.error||m.result)){let result=body.querySelector('.subagent-result');if(!result){result=document.createElement('div');result.className='subagent-result';body.appendChild(result)}result.classList.toggle('error',m.ok===false);result.textContent=m.ok===false?(m.error||'Subagent failed.'):(m.result||'Completed.')}}else{group.classList.remove('done','failed');group.open=true;if(state)state.textContent='Running'}
    const statusEl=activity?.querySelector('.activity-status');if(statusEl)statusEl.textContent=m.phase==='start'?(m.name||'Subagent working…'):'Working…';scrollActivity()
  }
  function updateTask(m){
    ensureActivity();enableActivity();
    const parentId=m.parentId?String(m.parentId):'';
    const container=parentId?ensureSubagentGroup({id:parentId,role:m.subagentRole}).querySelector('.subagent-body'):activityBody;
    if(!container)return;
    let row=container.querySelector('[data-task="'+CSS.escape(m.id)+'"]');
    if(!row){row=document.createElement('div');row.className='tool';row.dataset.task=m.id;row.innerHTML='<span class="task-state"></span><div class="task-label"></div>';container.appendChild(row);taskCount++}
    row.querySelector('.task-label').innerHTML=markdown(m.name);row.classList.toggle('failed',Boolean(m.failed));if(m.phase==='end')row.classList.add('done');
    const statusEl=activity.querySelector('.activity-status');if(statusEl)statusEl.textContent=m.phase==='start'?(parentId?'Subagent: ':'')+m.name:'Working…';scrollActivity()
  }

  function showRetry(m){ensureActivity();enableActivity();activityBody.querySelectorAll('.retry:not(.done):not(.failed)').forEach(row=>row.classList.add('done'));const row=document.createElement('div');row.className='tool retry';row.dataset.retry=String(m.attempt);row.innerHTML='<span class="task-state"></span><div class="task-label"></div>';const label='**Reconnecting '+m.attempt+'/'+m.max+'**'+(m.error?' — '+esc(m.error):'')+(m.backoffMs?' (retry in '+Math.round(m.backoffMs/1000)+'s)':'');row.querySelector('.task-label').innerHTML=markdown(label);activityBody.appendChild(row);taskCount++;const statusEl=activity.querySelector('.activity-status');if(statusEl)statusEl.textContent='Reconnecting '+m.attempt+'/'+m.max;scrollActivity()}
  function finishRetry(m){const rows=activityBody?.querySelectorAll('.retry');if(!rows?.length)return;const last=rows[rows.length-1];last.classList.add(m.ok?'done':'failed');last.querySelector('.task-label').innerHTML=markdown(m.ok?'**Reconnected '+m.attempt+'/'+m.max+'**':'**Reconnect failed '+m.attempt+'/'+m.max+'**');scrollActivity()}
  function finishActivity(){if(!activity)return;activity.classList.remove('loading');const seconds=Math.max(1,Math.round((Date.now()-phaseStartedAt)/1000));const summaryText='Worked for '+seconds+'s'+(taskCount?' · '+taskCount+' task'+(taskCount===1?'':'s'):'');const statusEl=activity.querySelector('.activity-status');if(statusEl)statusEl.textContent=summaryText;else activity.querySelector('summary').textContent=summaryText;const stopBtn=activity.querySelector('.activity-stop-btn');if(stopBtn)stopBtn.remove();activity.open=false}
  function nextWorkPhase(){closeCurrentText();if(activity){reasoning=document.createElement('div');reasoning.className='reasoning';reasoning.dataset.raw='';activityBody.appendChild(reasoning)}scroll()}
  function finish(item){closeCurrentText();finishActivity();if(item&&currentTurn){const pauseNotice=iterationPauseCard(item);if(pauseNotice)currentTurn.appendChild(pauseNotice);const changeSummary=changesCard(item);if(changeSummary)currentTurn.appendChild(changeSummary);currentTurn.appendChild(messageFooter(item,true))}currentTurn=current=activity=activityBody=reasoning=null;runningSet.delete(activeConversationId);syncSendButton();updateJump();scroll()}
  function renderConversationMenu(){
    const query=conversationQuery.trim().toLowerCase();const matches=x=>!query||String(x.title||'').toLowerCase().includes(query);const current=conversations.filter(x=>!x.archived&&matches(x)),pinned=current.filter(x=>x.pinned),active=current.filter(x=>!x.pinned),archived=conversations.filter(x=>x.archived&&matches(x));
    const row=x=>'<div class="conversation-row '+(x.id===activeConversationId?'active':'')+'" data-open="'+esc(x.id)+'">'+(x.running?'<span class="spinner"></span>':'')+'<span class="conversation-row-main"><span class="title">'+esc(x.title)+'</span><span class="conversation-meta">'+(x.status==='failed'?'Failed':x.status==='paused'?'Paused':x.running?'Running':x.changeCount?x.changeCount+' changed file'+(x.changeCount===1?'':'s'):x.messageCount?x.messageCount+' messages':'Empty')+'</span></span><button class="archive-action pin-action" data-pin="'+esc(x.id)+'" title="'+(x.pinned?'Unpin':'Pin')+'">'+(x.pinned?'★':'☆')+'</button><button class="archive-action rename-action" data-rename="'+esc(x.id)+'" title="Rename">✎</button><button class="archive-action" data-archive="'+esc(x.id)+'" title="'+(x.archived?'Restore':'Archive')+'">'+(x.archived?'↶':'<svg viewBox="0 0 24 24"><rect width="20" height="5" x="2" y="3" rx="1"/><path d="M4 8v11a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8"/><path d="M10 12h4"/></svg>')+'</button><button class="archive-action delete-action" data-delete="'+esc(x.id)+'" title="'+(x.archived?'Delete permanently':'Delete chat')+'">×</button></div>';
    const group=(label,items)=>items.length?'<div class="menu-label">'+label+'</div>'+items.map(row).join(''):'';
    conversationMenu.innerHTML='<div class="conversation-search-wrap"><input class="conversation-search" id="conversationSearch" placeholder="Search conversations…" value="'+esc(conversationQuery)+'"></div>'+group('Pinned',pinned)+group('Conversations',active)+group('Archived',archived)+(!pinned.length&&!active.length&&!archived.length?'<div class="dropdown-empty">No matching conversations.</div>':'');
    const search=conversationMenu.querySelector('#conversationSearch');if(search){search.oninput=()=>{conversationQuery=search.value;renderConversationMenu();const next=conversationMenu.querySelector('#conversationSearch');if(next){next.focus();next.setSelectionRange(conversationQuery.length,conversationQuery.length)}};search.onclick=e=>e.stopPropagation()}
    conversationMenu.querySelectorAll('[data-open]').forEach(el=>el.onclick=()=>{vscode.postMessage({type:'openConversation',id:el.dataset.open});conversationMenu.classList.remove('open')});
    conversationMenu.querySelectorAll('[data-pin]').forEach(el=>el.onclick=e=>{e.stopPropagation();vscode.postMessage({type:'togglePinConversation',id:el.dataset.pin})});
    conversationMenu.querySelectorAll('[data-rename]').forEach(el=>el.onclick=e=>{e.stopPropagation();vscode.postMessage({type:'renameConversation',id:el.dataset.rename})});
    conversationMenu.querySelectorAll('[data-archive]').forEach(el=>el.onclick=e=>{e.stopPropagation();vscode.postMessage({type:'archiveConversation',id:el.dataset.archive})});conversationMenu.querySelectorAll('[data-delete]').forEach(el=>el.onclick=e=>{e.stopPropagation();vscode.postMessage({type:'deleteConversation',id:el.dataset.delete})})
  }
  function retryButton(){const btn=document.createElement('button');btn.className='retry-btn';btn.title='Continue from where it stopped';btn.setAttribute('aria-label','Continue the last request');btn.innerHTML='<svg viewBox="0 0 24 24"><path d="M3 12a9 9 0 0 1 15.5-6.5L21 8"/><path d="M21 3v5h-5"/><path d="M21 12a9 9 0 0 1-15.5 6.5L3 16"/><path d="M3 21v-5h5"/></svg> Continue';btn.onclick=()=>vscode.postMessage({type:'retryMessage',conversationId:activeConversationId});return btn}
  function errorActions(){const actions=document.createElement('div');actions.className='error-actions';actions.appendChild(retryButton());return actions}
  function addError(text,retry){document.getElementById('empty')?.remove();const d=document.createElement('div');d.className='error';d.textContent=text;if(retry)d.appendChild(errorActions());messages.appendChild(d);scroll()}
  function showGenerationError(item){if(current){current.remove();current=null}if(currentTurn)currentTurn.appendChild(structuredErrorCard(item));else{document.getElementById('empty')?.remove();messages.appendChild(structuredErrorCard(item))}finish(item)}
  function updateSendMode(){const stopping=isRunning()&&!input.value.trim();send.classList.toggle('stop',stopping);send.classList.toggle('loading',isRunning()&&!stopping);send.title=stopping?'Stop':'Send'}
  function compactPrice(value){if(value===undefined||value===null)return'';const n=Number(value);if(!Number.isFinite(n))return'';if(n>=1)return'$'+trimNum(n.toFixed(2));if(n>=.01)return'$'+trimNum(n.toFixed(3));return'$'+trimNum(n.toFixed(4))}
  function modelMeta(m,mid,providerId){if(typeof m==='object'&&m&&m.isAuto)return'Cheapest model first · A–Z fallback';const price=providerId==='sleepyai'?(sleepyModelPrices||[]).find(p=>p.modelId===mid||p.name===mid||p.name===modelNameOf(m)):undefined;const context=(typeof m==='object'&&m&&m.contextWindow)||price?.contextWindow||0;const parts=[];if(typeof m==='object'&&m&&m.recommended)parts.push('Recommended');if(context)parts.push(fmt(context)+' context');if(price&&price.inputPrice!==undefined&&price.outputPrice!==undefined)parts.push(compactPrice(price.inputPrice)+' / '+compactPrice(price.outputPrice)+' per 1M in/out');return parts.join(' · ')}
  function renderModelMenu(){
    modelMenu.innerHTML='';
    if(!modelGroups.length){
      const empty=document.createElement('div');
      empty.className='dropdown-empty';
      empty.textContent='No models available yet.';
      modelMenu.appendChild(empty);
      return;
    }
    for(const group of modelGroups){
      const label=document.createElement('div');
      label.className='dropdown-group-label';
      label.textContent=group.providerId==='sleepyai'?'SleepyAI':group.providerName;
      modelMenu.appendChild(label);
      for(const m of [...(group.models||[])].sort(modelA2Z)){
        const mid=modelIdOf(m);
        const mname=modelNameOf(m);
        const meta=modelMeta(m,mid,group.providerId);
        const opt=document.createElement('button');
        opt.type='button';
        opt.className='dropdown-option model-option'+(mid===selectedModel?' selected':'');
        opt.innerHTML='<span class="model-option-head"><span class="model-option-name">'+esc(mname)+'</span>'+((typeof m==='object'&&m&&(m.isAuto||m.recommended))?'<span class="model-recommended">'+(m.isAuto?'Recommended':'Preferred')+'</span>':'')+(mid===selectedModel?'<span class="model-option-check">✓</span>':'')+'</span>'+(meta?'<span class="model-option-meta">'+esc(meta)+'</span>':'');
        opt.title=mid+' ('+group.providerName+')';
        opt.onclick=()=>selectModel(mid,group.providerId);
        modelMenu.appendChild(opt);
      }
    }
  }
  function closeModelMenu(){modelMenu.classList.remove('open')}
  function toggleModelMenu(){modelMenu.classList.toggle('open');if(modelMenu.classList.contains('open'))renderModelMenu()}
  function selectModel(id,providerId){
    selectedModel=id;
    const name=findModelName(id);
    modelButton.textContent=name;
    modelButton.title=id;
    closeModelMenu();
    vscode.postMessage({type:'selectModel',model:id,provider:providerId});
    updateSessionStats();
  }
  document.getElementById('approvalMode')?.addEventListener('change', ()=>{syncSafetyControl();autosaveNow()});
  syncSafetyControl();
  syncAgentPill();
  function submit(){let text=input.value.trim();const wasRunning=isRunning();if(wasRunning&&!text&&!attachments.length){vscode.postMessage({type:'stop'});return}if(!text&&!attachments.length)return;if(text.startsWith('/')){const slash=expandSlashPrompt(text);if(slash.handled){input.value='';closeSlashMenu();resize();return}text=slash.text}if(!selectedModel){addError('Choose a model first.');return}const sentAttachments=[...attachments];const context={includeProjectIndex,includeActiveFile,includeSelection,activeFile:editorContext.activeFile,selectionLines:editorContext.selectionLines,attachments:sentAttachments};const optimisticText=text||'Please inspect the attached files.';const edit=editMessageState?{...editMessageState}:null;editMessageState=null;setEditBar(false);input.value='';attachments=[];renderAttachments();closeContextPanel();closeSlashMenu();resize();if(!edit){if(wasRunning){queuedByConversation.set(activeConversationId,optimisticText);updateQueuedVisibility();vscode.postMessage({type:'send',text:optimisticText,conversationId:activeConversationId,context});updateSendMode();return}send.classList.add('loading');send.classList.add('stop');const sSvg=send.querySelector('.send-svg'),xSvg=send.querySelector('.stop-svg');if(sSvg)sSvg.style.display='none';if(xSvg)xSvg.style.display='block';runningSet.add(activeConversationId);updateJump();updateSendMode();try{const now=Date.now(),optimistic={id:'tmp-'+now,role:'user',text:optimisticText,timestamp:now,attachments:sentAttachments};beginTurn(optimistic);createActivity();const st=activity&&activity.querySelector('.activity-status');if(st)st.textContent='Sending…';scroll(true)}catch(e){}vscode.postMessage({type:'send',text:optimisticText,conversationId:activeConversationId,context})}else{vscode.postMessage({type:'editUserMessage',conversationId:edit.conversationId,itemId:edit.itemId,text:optimisticText,context})}}
  function resize(){input.style.height='auto';const viewportCap=Math.max(72,Math.min(180,Math.floor(window.innerHeight*.28)));input.style.height=Math.min(input.scrollHeight,viewportCap)+'px';updateSendMode();if(followOutput)pinScroll();updateJump()}
  send.onclick=()=>{if(isRunning()&&!input.value.trim()){vscode.postMessage({type:'stop'});return}submit()};input.oninput=resize;input.onkeydown=e=>{if(e.key==='Enter'&&!e.shiftKey){e.preventDefault();submit()}};
  messages.addEventListener('scroll',()=>{followOutput=nearBottom();updateJump()});jumpBottom.onclick=()=>{followOutput=true;scroll(true)};projectIndicator.onclick=()=>{if(projectIndicatorPath)vscode.postMessage({type:'revealInOS'})};document.getElementById('statPillGroup')?.addEventListener('click',()=>toggleSessionInfo());document.getElementById('statPillGroup')?.addEventListener('keydown',e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();toggleSessionInfo()}});
    const composerEl=document.querySelector('.composer');if(typeof ResizeObserver!=='undefined'&&composerEl)new ResizeObserver(()=>{updateJump();if(followOutput)pinScroll()}).observe(composerEl);window.addEventListener('resize',()=>{resize();updateJump()});
  document.getElementById('steerQueued').onclick=()=>vscode.postMessage({type:'steerQueued',conversationId:activeConversationId});document.getElementById('editQueued').onclick=()=>{const prompt=queuedByConversation.get(activeConversationId);if(!prompt)return;queuedByConversation.delete(activeConversationId);updateQueuedVisibility();vscode.postMessage({type:'removeQueued',conversationId:activeConversationId});input.value=prompt;resize();input.focus()};document.getElementById('removeQueued').onclick=()=>vscode.postMessage({type:'removeQueued',conversationId:activeConversationId});
  document.getElementById('loginBannerBtn').onclick=()=>vscode.postMessage({type:'requestSettings'});
  const undoBtn=document.getElementById('undoButton'),redoBtn=document.getElementById('redoButton');if(undoBtn)undoBtn.onclick=async()=>{const choice=await showNotifyModal({title:'Undo last turn?',body:'This will remove the last assistant response and your last message. You can redo later.',ok:'Undo',cancel:'Cancel'});if(choice==='ok')vscode.postMessage({type:'undoLastTurn',conversationId:activeConversationId})};if(redoBtn)redoBtn.onclick=async()=>{const choice=await showNotifyModal({title:'Redo last turn?',body:'This will restore the last undone turn.',ok:'Redo',cancel:'Cancel'});if(choice==='ok')vscode.postMessage({type:'redoLastTurn',conversationId:activeConversationId})};
  const settingsView=document.getElementById('settingsView'),maxSteps=document.getElementById('maxSteps'),maxStepsUnlimited=document.getElementById('maxStepsUnlimited'),approvalMode=document.getElementById('approvalMode'),searxngUrl=document.getElementById('searxngUrl'),mcpServers=document.getElementById('mcpServers'),extraFreeModels=document.getElementById('extraFreeModels'),settingsResult=document.getElementById('settingsResult'),providerList=document.getElementById('providerList'),onlyDefaultModels=document.getElementById('onlyDefaultModels'),confirmDelete=document.getElementById('confirmDelete');let initialSetup=false,savedApiKeys={},providersList=[],activeProvider='',settingsSavedTimer=null,sleepyAccount=null,sleepyBusy=false,sleepyStatusText='';
  const resetSettingsBtn=document.getElementById('resetSettings');let resetClicks=0,autosaveTimer=null;
  function resetArmGuard(){resetClicks=0;resetSettingsBtn.textContent='Reset to defaults'}
  function settingsPayload(){return{maxSteps:maxStepsUnlimited.checked?0:(Number(maxSteps.value)||50),approvalMode:approvalMode.value,searxngUrl:searxngUrl.value,mcpServers:mcpServers.value,extraFreeModels:extraFreeModels.value,activeProvider:activeProvider,providers:providersList,apiKey:'',onlyDefaultModels:onlyDefaultModels.checked,confirmDelete:confirmDelete.checked,initialSetup}}
  function autosaveNow(){resetArmGuard();clearTimeout(autosaveTimer);vscode.postMessage({type:'saveSettings',...settingsPayload()})}
  function autosaveLater(){resetArmGuard();clearTimeout(autosaveTimer);autosaveTimer=setTimeout(()=>vscode.postMessage({type:'saveSettings',...settingsPayload()}),350)}
  function renderSleepyCard(){
    const loginBanner=document.getElementById('loginBanner');
    if(loginBanner){loginBanner.classList.toggle('visible',Boolean(!sleepyAccount||!sleepyAccount.loggedIn))}
    const el=document.getElementById('sleepyCardBody');
    if(!el)return;
    if(sleepyBusy){el.innerHTML='<div style="display:flex;align-items:center;gap:8px;font-size:12px"><span class="spinner"></span><span>'+esc(sleepyStatusText||'Connecting to SleepyAI…')+'</span></div>';return}
    if(sleepyAccount&&sleepyAccount.loggedIn){
      const fmtMoney=n=>{if(n===undefined||n===null)return'—';return'$'+Number(n).toFixed(2)};
      const fmtTokens=n=>{if(n===undefined||n===null)return'—';if(n>=1000000)return(n/1000000).toFixed(1)+'M';if(n>=1000)return(n/1000).toFixed(1)+'k';return String(n)};
      const pctClass=pct=>pct>=80?'danger':pct>=50?'warn':'safe';
      const makeBar=(used,limit)=>{
        if(used===undefined||limit===undefined||limit<=0)return'';
        const pct=Math.min(100,Math.round((used/limit)*100));
        return'<div class="limit-row"><div class="limit-header"><span class="limit-value">'+fmtMoney(used)+' / '+fmtMoney(limit)+'</span></div><div class="limit-bar-track"><div class="limit-bar-fill '+pctClass(pct)+'" style="width:'+pct+'%"></div></div><div class="limit-bar-pct">'+pct+'%</div></div>';
      };
      const lim=sleepyAccount.limits||{};
      const sub=sleepyAccount.subscription||{};
      const bal=sleepyAccount.balances||{};
      let html='<div style="display:flex;flex-direction:column;gap:14px">';
      html+='<div class="sleepy-account-head"><div class="sleepy-account-main"><div class="sleepy-account-title">Signed in to SleepyAI</div>'+(sleepyAccount.email?'<div class="sleepy-account-email">'+esc(sleepyAccount.email)+'</div>':'')+'</div>'+(activeProvider==='sleepyai'?'<span class="sleepy-active">Active</span>':'<button type="button" class="primary" id="sleepyUseBtn">Use SleepyAI</button>')+'<button type="button" class="small-btn" id="sleepyLogoutBtn">Sign out</button></div><div class="sleepy-account-links"><button type="button" class="secondary" id="sleepyManageBtn">Manage account</button><button type="button" class="secondary" id="sleepyWebsiteBtn">SleepyAI website ↗</button></div>';
      html+='<div style="display:flex;flex-wrap:wrap;gap:6px">';
      if(sub.plan)html+='<span style="padding:3px 10px;border-radius:999px;background:color-mix(in srgb,var(--vscode-focusBorder) 12%,transparent);color:var(--vscode-foreground);font-size:11px;font-weight:500">'+esc(sub.plan)+'</span>';
      if(sub.status)html+='<span style="padding:3px 10px;border-radius:999px;background:color-mix(in srgb,var(--vscode-testing-iconPassed) 12%,transparent);color:var(--vscode-testing-iconPassed);font-size:11px">'+esc(sub.status)+'</span>';
      html+='</div>';
      html+='<div style="display:flex;gap:14px;flex-wrap:wrap;font-size:11px;color:var(--vscode-descriptionForeground)">';
      html+='<div><span style="color:var(--vscode-foreground);font-weight:500">Balance</span><br>'+fmtMoney(bal.credits)+'</div>';
      if(bal.freeCreditsRemaining!==undefined)html+='<div><span style="color:var(--vscode-foreground);font-weight:500">Extra Credits</span><br>'+fmtMoney(bal.freeCreditsRemaining)+'</div>';
      if(sub.monthlySpend!==undefined)html+='<div><span style="color:var(--vscode-foreground);font-weight:500">Monthly</span><br>'+fmtMoney(sub.monthlySpend)+' / '+fmtMoney(sub.monthlyLimit)+'</div>';
      html+='</div>';
      if(lim.usedTokensToday!==undefined&&lim.tokensPerDay!==undefined){
        const pct=Math.min(100,Math.round((lim.usedTokensToday/lim.tokensPerDay)*100));
        html+='<div><div class="limit-section-title">Daily Free Model Tokens</div><div class="limit-header"><span class="limit-value">'+fmtTokens(lim.usedTokensToday)+' / '+fmtTokens(lim.tokensPerDay)+'</span></div><div class="limit-bar-track"><div class="limit-bar-fill '+pctClass(pct)+'" style="width:'+pct+'%"></div></div><div class="limit-bar-pct">'+pct+'% used</div></div>';
      }
      const hasLimits=lim.limit5h!==undefined||lim.limit24h!==undefined||lim.limitWeekly!==undefined||lim.limitMonthly!==undefined;
      if(hasLimits){
        html+='<div class="limit-section"><div class="limit-section-title">Spending Limits</div>';
        html+=makeBar(lim.cost5h,lim.limit5h);
        html+=makeBar(lim.cost24h,lim.limit24h);
        html+=makeBar(lim.costWeekly,lim.limitWeekly);
        html+=makeBar(lim.costMonthly,lim.limitMonthly);
        html+='</div>';
      }
      html+='</div>';
      el.innerHTML=html;
      const useBtn=el.querySelector('#sleepyUseBtn');
      if(useBtn)useBtn.onclick=()=>{activeProvider='sleepyai';renderSleepyCard();renderProviderList();autosaveNow()};
      const btn=el.querySelector('#sleepyLogoutBtn');
      if(btn)btn.onclick=()=>vscode.postMessage({type:'sleepyLogout'});
      const manageBtn=el.querySelector('#sleepyManageBtn');if(manageBtn)manageBtn.onclick=()=>vscode.postMessage({type:'openSleepyDashboard'});
      const websiteBtn=el.querySelector('#sleepyWebsiteBtn');if(websiteBtn)websiteBtn.onclick=()=>vscode.postMessage({type:'openSleepyWebsite'});
    }else{
      el.innerHTML='<div style="display:flex;flex-direction:column;gap:10px"><div><div style="font-size:13px;font-weight:600">Sign in to SleepyAI</div><div style="font-size:11px;color:var(--vscode-descriptionForeground);margin-top:3px">Use SleepyAI models with one click. Credentials are stored at <code>~/.sleepy/gateway.json</code>, shared with the Sleepy CLI.</div></div><div class="sleepy-login-actions"><button type="button" class="primary" id="sleepyLoginBtn">Sign in with browser</button><button type="button" class="secondary" id="sleepyDeviceBtn">Use activation code</button><button type="button" class="secondary" id="sleepyWebsiteBtn">Visit SleepyAI ↗</button></div></div>';
      const lb=el.querySelector('#sleepyLoginBtn');if(lb)lb.onclick=()=>vscode.postMessage({type:'sleepyLogin'});
      const db=el.querySelector('#sleepyDeviceBtn');if(db)db.onclick=()=>vscode.postMessage({type:'sleepyDeviceLogin'});
      const wb=el.querySelector('#sleepyWebsiteBtn');if(wb)wb.onclick=()=>vscode.postMessage({type:'openSleepyWebsite'});
    }
    renderSleepyPricing();
  }
  function renderSleepyPricing(){
    const el=document.getElementById('sleepyPricing');
    if(!el)return;
    if(!sleepyAccount||!sleepyAccount.loggedIn){el.innerHTML='<div style="font-size:11px;color:var(--vscode-descriptionForeground);padding:8px 0">Sign in to SleepyAI to view account plan and pricing.</div>';return}
    if(!sleepyModelPrices||!sleepyModelPrices.length){
      if(sleepyBusy){
        el.innerHTML='<div style="font-size:11px;color:var(--vscode-descriptionForeground);padding:8px 0"><span class="spinner"></span> Loading pricing…</div>';
      }else{
        el.innerHTML='<div style="font-size:11px;color:var(--vscode-descriptionForeground);padding:8px 0">No model pricing data returned from gateway.</div>';
      }
      return;
    }
    const fmtPrice=n=>{if(n===undefined||n===null)return'—';if(n>=1)return'$'+n.toFixed(2)+'/M';if(n>=0.001)return'$'+n.toFixed(3)+'/M';return'$'+n.toFixed(4)+'/M'};
    let html='<table style="width:100%;border-collapse:collapse;font-size:11px">';
    html+='<thead><tr style="border-bottom:1px solid var(--vscode-widget-border)"><th style="text-align:left;padding:4px 6px;font-weight:600">Model</th><th style="text-align:right;padding:4px 6px;font-weight:600">Input</th><th style="text-align:right;padding:4px 6px;font-weight:600">Output</th><th style="text-align:right;padding:4px 6px;font-weight:600">Cache Read</th><th style="text-align:right;padding:4px 6px;font-weight:600">Cache Write</th></tr></thead><tbody>';
    for(const p of sleepyModelPrices){
      html+='<tr style="border-bottom:1px solid color-mix(in srgb,var(--vscode-widget-border) 50%,transparent)"><td style="padding:4px 6px">'+esc(p.name||p.modelId)+'</td><td style="text-align:right;padding:4px 6px">'+fmtPrice(p.inputPrice)+'</td><td style="text-align:right;padding:4px 6px">'+fmtPrice(p.outputPrice)+'</td><td style="text-align:right;padding:4px 6px">'+fmtPrice(p.cacheReadPrice)+'</td><td style="text-align:right;padding:4px 6px">'+fmtPrice(p.cacheWritePrice)+'</td></tr>';
    }
    html+='</tbody></table>';
    el.innerHTML=html;
  }
  function renderProviderList(){
    if(!providersList||!providersList.length){
      providerList.innerHTML='<div style="font-size:11px;color:var(--vscode-descriptionForeground);padding:8px 2px">SleepyAI is always available. Add an optional compatibility provider below if needed.</div>';
      return;
    }
    providerList.innerHTML=(providersList||[]).map(p=>{
      const isActive=p.id===activeProvider;
      const isSleepy=p.id==='sleepyai';
      const hasKey=Boolean(savedApiKeys[p.id]);
      return '<div class="provider-row'+(isActive?' active':'')+'\" data-provider-id="'+esc(p.id)+'" style="display:flex;align-items:center;gap:8px;padding:8px 10px;border:1px solid var(--vscode-widget-border);border-radius:6px;cursor:pointer;'+(isActive?'border-color:var(--vscode-focusBorder);background:var(--vscode-list-activeSelectionBackground);':'')+'">'+
        '<div style="flex:1;min-width:0"><div style="font-weight:600;font-size:12px">'+esc(p.name)+'</div><div style="font-size:10px;color:var(--vscode-descriptionForeground);overflow:hidden;text-overflow:ellipsis;white-space:nowrap">'+esc(p.baseURL)+'</div></div>'+
        (isSleepy?'<span style="font-size:10px;color:var(--vscode-testing-iconPassed)">First-party'+(sleepyAccount&&sleepyAccount.loggedIn?' · Signed in':'')+'</span>':(hasKey?'<span style="font-size:10px;color:var(--vscode-descriptionForeground)">Key saved</span>':'<span style="font-size:10px;color:var(--vscode-descriptionForeground)">Optional</span>'))+
        (isSleepy?'':'<button type="button" class="small-btn provider-edit" data-edit="'+esc(p.id)+'" style="margin-left:auto;flex:none">Edit</button>')+
      '</div>';
    }).join('');
    providerList.querySelectorAll('[data-provider-id]').forEach(row=>{
      row.onclick=e=>{if(e.target.closest('.provider-edit'))return;activeProvider=row.dataset.providerId;renderProviderList();autosaveNow()};
    });
    providerList.querySelectorAll('[data-edit]').forEach(btn=>{
      btn.onclick=e=>{e.stopPropagation();openProviderForm(btn.dataset.edit)};
    });
  }
  const providerForm=document.getElementById('providerForm'),providerFormTitle=document.getElementById('providerFormTitle'),pfName=document.getElementById('pf-name'),pfUrl=document.getElementById('pf-url'),pfModels=document.getElementById('pf-models'),pfHeaders=document.getElementById('pf-headers'),pfApiKey=document.getElementById('pf-api-key'),pfApiKeyStatus=document.getElementById('pf-api-key-status'),pfSave=document.getElementById('pf-save'),pfCancel=document.getElementById('pf-cancel'),pfDelete=document.getElementById('pf-delete'),pfError=document.getElementById('pf-error');
  let providerFormEditId=null,pendingProviderKeyId='',pendingProviderKey='';
  function openProviderForm(editId){
    providerFormEditId=editId||null;
    const p=editId?providersList.find(x=>x.id===editId):null;
    providerFormTitle.textContent=editId?'Edit provider':'Add provider';
    pfName.value=p?p.name:'';
    pfUrl.value=p?p.baseURL:'';
    pfModels.value=p&&p.modelList?p.modelList.join(', '):'';
    pfHeaders.value=p&&p.customHeaders&&Object.keys(p.customHeaders).length?JSON.stringify(p.customHeaders,null,2):'';
    pfApiKey.value='';
    pfApiKeyStatus.textContent=p&&savedApiKeys[p.id]?'A key is already saved. Paste a replacement or leave blank to keep it.':'Optional. Leave blank to use no API key.';
    pfDelete.style.display=editId?'':'none';
    pfError.textContent='';
    providerForm.style.display='';
    setTimeout(()=>pfName.focus(),0);
  }
  function closeProviderForm(){providerForm.style.display='none';providerFormEditId=null;pfError.textContent=''}
  function saveProviderForm(){
    const name=pfName.value.trim();
    const url=pfUrl.value.trim();
    const modelsRaw=pfModels.value.trim();
    if(!name){pfError.textContent='Name is required.';pfName.focus();return}
    if(!url||!/^https?:\/\//i.test(url)){pfError.textContent='Base URL must start with http:// or https://';pfUrl.focus();return}
    const modelList=modelsRaw?modelsRaw.split(',').map(s=>s.trim()).filter(Boolean):undefined;
    let customHeaders=undefined;
    if(pfHeaders.value.trim()){
      try{const parsed=JSON.parse(pfHeaders.value);if(!parsed||typeof parsed!=='object'||Array.isArray(parsed)||Object.values(parsed).some(v=>typeof v!=='string'))throw new Error();customHeaders=parsed}catch{pfError.textContent='Custom headers must be a JSON object with string values.';pfHeaders.focus();return}
    }
    let savedProviderId=providerFormEditId;
    if(providerFormEditId){
      const p=providersList.find(x=>x.id===providerFormEditId);
      if(p){p.name=name;p.baseURL=url;p.modelList=modelList;p.customHeaders=customHeaders}
    }else{
      const generated=name.toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/^-+|-+$/g,'').slice(0,40)||('provider-'+Date.now());
      const id=generated==='sleepyai'?'sleepyai-custom':generated;
      const finalId=providersList.some(x=>x.id===id)?id+'-'+Date.now():id;
      providersList.push({id:finalId,name,baseURL:url,customHeaders,modelList});
      savedProviderId=finalId;
      if(!activeProvider)activeProvider=finalId;
    }
    if(pfApiKey.value.trim()){
      pendingProviderKeyId=savedProviderId;
      pendingProviderKey=pfApiKey.value.trim();
    }
    closeProviderForm();
    renderProviderList();
    autosaveNow();
  }
  function deleteProviderFromForm(){
    if(!providerFormEditId)return;
    providersList=providersList.filter(x=>x.id!==providerFormEditId);
    if(activeProvider===providerFormEditId)activeProvider=providersList[0]?.id||'';
    closeProviderForm();
    renderProviderList();
    autosaveNow();
  }
  pfSave.onclick=saveProviderForm;
  pfCancel.onclick=closeProviderForm;
  pfDelete.onclick=deleteProviderFromForm;
  pfName.onkeydown=pfUrl.onkeydown=pfModels.onkeydown=pfHeaders.onkeydown=e=>{if(e.key==='Enter'){e.preventDefault();saveProviderForm()}if(e.key==='Escape')closeProviderForm()};
  function openProviderEditor(id){openProviderForm(id)}
  function addProvider(){openProviderForm(null)}
  function openSettings(m){initialSetup=Boolean(m.initialSetup);savedApiKeys=m.apiKeys||{};providersList=m.providers||[];activeProvider=m.activeProvider||'';if(!activeProvider&&providersList.length)activeProvider=providersList[0].id;sleepyAccount=m.sleepy||null;if(sleepyAccount&&sleepyAccount.modelPrices&&sleepyAccount.modelPrices.length)sleepyModelPrices=sleepyAccount.modelPrices;sleepyBusy=false;sleepyStatusText='';settingsView.classList.toggle('onboarding',initialSetup);document.getElementById('settingsTitle').textContent=initialSetup?'Set up SleepyCode':'SleepyCode Settings';selectSettingsTab(initialSetup?'sleepyai':activeSettingsTab);renderProviderList();renderSleepyCard();if(sleepyAccount&&sleepyAccount.loggedIn){vscode.postMessage({type:'sleepyAccountData'})}maxSteps.value=m.maxSteps===0?50:(m.maxSteps??50);maxStepsUnlimited.checked=m.maxSteps===0;maxSteps.disabled=maxStepsUnlimited.checked;onlyDefaultModels.checked=Boolean(m.onlyDefaultModels);confirmDelete.checked=m.confirmDelete!==false;approvalMode.value=m.approvalMode||'ask';syncSafetyControl();searxngUrl.value=m.searxngUrl||'';mcpServers.value=m.mcpServers||'{}';extraFreeModels.value=(m.extraFreeModels||'');if(m.agentId){selectedAgentId=m.agentId;syncAgentPill()}settingsResult.textContent='';settingsResult.className='settings-result';document.querySelector('.app').style.display='none';settingsView.classList.add('visible');resetArmGuard();clearTimeout(autosaveTimer);clearTimeout(settingsSavedTimer);setTimeout(()=>{const target=initialSetup?document.getElementById('sleepyLoginBtn'):maxSteps;if(target)target.focus()},0)}
  function closeSettings(){settingsView.classList.remove('visible');document.querySelector('.app').style.display='flex'}
  let activeSettingsTab='sleepyai';
  function selectSettingsTab(tab){
    activeSettingsTab=tab;
    document.querySelectorAll('[data-settings-tab]').forEach(button=>button.classList.toggle('active',button.dataset.settingsTab===tab));
    document.querySelectorAll('[data-settings-pane]').forEach(pane=>pane.classList.toggle('active',pane.dataset.settingsPane===tab));
  }
  document.querySelectorAll('[data-settings-tab]').forEach(button=>button.onclick=()=>selectSettingsTab(button.dataset.settingsTab));
  modelDropdown.onclick=e=>{if(!e.target.closest('#modelMenu'))toggleModelMenu()};if(agentDropdown)agentDropdown.onclick=e=>{if(!e.target.closest('#agentMenu'))toggleAgentMenu()};if(safetyDropdown)safetyDropdown.onclick=e=>{if(!e.target.closest('#safetyMenu')){const open=!safetyMenu.classList.contains('open');safetyMenu.classList.toggle('open',open);safetyButton?.setAttribute('aria-expanded',String(open));if(open)renderSafetyMenu()}};contextSummaryButton?.addEventListener('click',e=>{e.stopPropagation();toggleContextPanel()});document.getElementById('contextAddButton')?.addEventListener('click',()=>vscode.postMessage({type:'requestFilePicker'}));document.addEventListener('click',e=>{if(!modelDropdown.contains(e.target))closeModelMenu();if(agentDropdown&&!agentDropdown.contains(e.target))closeAgentMenu();if(safetyDropdown&&!safetyDropdown.contains(e.target)){safetyMenu?.classList.remove('open');safetyButton?.setAttribute('aria-expanded','false')}if(contextPanel&&!contextPanel.contains(e.target)&&contextSummaryButton&&!contextSummaryButton.contains(e.target))closeContextPanel()});document.getElementById('usageButton').onclick=openUsageView;document.getElementById('usageBack').onclick=closeUsageView;document.getElementById('usageRefresh').onclick=()=>{vscode.postMessage({type:'requestUsage'});vscode.postMessage({type:'sleepyAccountData'})};document.getElementById('marketplaceButton').onclick=()=>{openMarketplaceView();vscode.postMessage({type:'requestMarketplaceInstalled'})};document.getElementById('marketplaceBack').onclick=closeMarketplaceView;document.getElementById('marketplaceRefresh').onclick=()=>{if(marketplaceTab==='installed'){vscode.postMessage({type:'requestMarketplaceInstalled'})}else if(marketplaceQuery.value.trim()){marketplaceSearch()}else if(!marketplaceBusy){loadMarketplaceTop(true,marketplaceSort.value)}};document.getElementById('marketplaceSearchBtn').onclick=marketplaceSearch;marketplaceQuery.onkeydown=e=>{if(e.key==='Enter'){e.preventDefault();marketplaceSearch()}};marketplaceQuery.oninput=()=>runMarketplaceSearch(true);marketplaceSort.onchange=()=>runMarketplaceSearch(false);document.getElementById('marketplaceRepoBtn').onclick=marketplaceListRepo;marketplaceRepo.onkeydown=e=>{if(e.key==='Enter'){e.preventDefault();marketplaceListRepo()}};document.getElementById('previewClose').onclick=closeSkillPreview;previewModal.onclick=e=>{if(e.target===previewModal)closeSkillPreview()};previewInstall.onclick=()=>{if(!previewState)return;const path=previewState.path;startSkillInstall(previewState.origin===null||previewState.origin===undefined?-1:previewState.origin,{install:{source:previewState.source,skill:path?path.split('/').pop():undefined}})};document.getElementById('settingsButton').onclick=()=>vscode.postMessage({type:'requestSettings'});document.getElementById('settingsBack').onclick=closeSettings;document.getElementById('newConversation').onclick=()=>vscode.postMessage({type:'newConversation'});document.getElementById('conversationButton').onclick=()=>conversationMenu.classList.toggle('open');
  resetSettingsBtn.onclick=()=>{resetClicks++;if(resetClicks>=3){resetClicks=0;resetSettingsBtn.textContent='Reset to defaults';vscode.postMessage({type:'resetSettings'});return}resetSettingsBtn.textContent=resetClicks===1?'Click 2 more times to reset':'Click 1 more time to reset'};
  maxStepsUnlimited.onchange=()=>{maxSteps.disabled=maxStepsUnlimited.checked;autosaveNow()};
  maxSteps.oninput=autosaveLater;
  document.getElementById('addProvider').onclick=addProvider;
  onlyDefaultModels.onchange=autosaveNow;
  confirmDelete.onchange=autosaveNow;
  approvalMode.onchange=autosaveNow;
  searxngUrl.oninput=autosaveLater;
  mcpServers.oninput=autosaveLater;
  extraFreeModels.oninput=autosaveLater;
  window.addEventListener('message',async({data:m})=>{switch(m.type){
    case'editorContext':editorContext={activeFile:m.activeFile||'',hasSelection:Boolean(m.hasSelection),selectionLines:m.selectionLines||''};renderContext();renderProjectIndicator();break;
    case'contextAttachments':attachments.push(...(m.attachments||[]).filter(item=>!attachments.some(existing=>existing.kind===item.kind&&((item.kind==='image'&&existing.name===item.name)||(item.kind!=='image'&&existing.path===item.path)))));renderAttachments();break;
    case'fileMentionResults':mentionResults=m.results||[];renderMentionMenu(mentionResults);break;
    case'project':{const nextPath=m.path||'';if(projectIndicatorPath!==nextPath)projectIndexState={status:'idle',text:'Preparing local project index…',indexed:0,total:0,index:null};projectIndicatorFolder=m.name||'No folder open';projectIndicatorPath=nextPath;projectIndicator.classList.toggle('clickable',Boolean(projectIndicatorPath));renderProjectIndicator();renderContext();refreshEmpty();break}
    case'projectIndex':projectIndexState={status:m.status||'idle',text:m.text||'',indexed:m.indexed||0,total:m.total||0,index:m.index||null};renderContext();refreshEmpty();break;
    case'conversations':conversations=m.conversations||[];activeConversationId=m.activeId;conversationTitle.textContent=conversations.find(x=>x.id===activeConversationId)?.title||'New conversation';runningSet=new Set(conversations.filter(x=>x.running).map(x=>x.id));queuedByConversation=new Map(conversations.map(x=>[x.id,x.queued||null]));renderConversationMenu();refreshEmpty();updateQueuedVisibility();modelButton.disabled=isRunning();syncSendButton();ensureOptimisticActivity();updateSendMode();updateJump();break;
    case'conversation':if(editMessageState&&editMessageState.conversationId!==m.id){editMessageState=null;setEditBar(false);input.value='';attachments=[];renderAttachments();resize()}activeConversationId=m.id;activeConversationItems=m.items||[];renderConversation(m.items);renderLive(m.id);updateQueuedVisibility();modelButton.disabled=isRunning();updateSendMode();updateJump();updateSessionStats();break;
    case'settings':openSettings(m);break;
    case'settingsResult':{if(m.ok&&(m.text==='Settings saved.'||String(m.text||'').startsWith('Signed in to SleepyAI'))){initialSetup=false;settingsView.classList.remove('onboarding');if(pendingProviderKeyId&&pendingProviderKey){vscode.postMessage({type:'saveProviderApiKey',providerId:pendingProviderKeyId,apiKey:pendingProviderKey});pendingProviderKeyId='';pendingProviderKey=''}}clearTimeout(settingsSavedTimer);if(m.ok){settingsResult.className='settings-result';void settingsResult.offsetWidth;settingsResult.textContent='Saved';settingsResult.className='settings-result ok';settingsSavedTimer=setTimeout(()=>{settingsResult.textContent='';settingsResult.className='settings-result'},1800)}else{settingsResult.textContent=m.text;settingsResult.className='settings-result bad'}break}
    case'apiKeyState':savedApiKeys[m.provider]=m.hasApiKey;renderProviderList();break;
    case'sleepyStatus':sleepyAccount={loggedIn:Boolean(m.loggedIn),email:m.email||sleepyAccount?.email||'',tier:m.tier||sleepyAccount?.tier||'',limits:m.limits||sleepyAccount?.limits,balances:m.balances||sleepyAccount?.balances,subscription:m.subscription||sleepyAccount?.subscription,modelPrices:m.modelPrices||sleepyAccount?.modelPrices};sleepyBusy=Boolean(m.busy);sleepyStatusText=m.text||'';if(m.modelPrices&&m.modelPrices.length)sleepyModelPrices=m.modelPrices;if(m.loggedIn&&m.provider){providersList=providersList||[];const existingIndex=providersList.findIndex(p=>p.id==='sleepyai');if(existingIndex>=0)providersList[existingIndex]=m.provider;else providersList.unshift(m.provider);activeProvider='sleepyai'}renderSleepyCard();renderProviderList();renderModelMenu();if(usageView.classList.contains('visible'))renderUsage();updateSessionStats();refreshEmpty();break;
    case'config':if(m.model){selectedModel=m.model;modelButton.textContent=findModelName(m.model)}if(m.approvalMode){approvalMode.value=m.approvalMode;syncSafetyControl()}if(m.agentId){selectedAgentId=m.agentId;syncAgentPill()}break;
    case'models':{modelGroups=m.groups||[];selectedModel=m.selected||'';modelButton.textContent=selectedModel?findModelName(selectedModel):'Choose model…';modelButton.title=selectedModel;renderModelMenu();updateSessionStats();break}
    case'modelRoute':{if(m.conversationId===activeConversationId){const s=liveState(m.conversationId);ensureLiveActivity(s);s.activity.summary='Auto routed to '+(findModelName(m.model)||m.model);if(currentTurn){ensureActivity();enableActivity();const d=document.createElement('div');d.className='route-note';d.textContent='Auto → '+(findModelName(m.model)||m.model)+(m.reason?' · '+m.reason:'');activityBody.appendChild(d);scrollActivity()}}break}
    case'modelsError':addError(m.text);break;
    case'showUsage':openUsageView();break;case'showMarketplace':openMarketplaceView();break;case'marketplaceInstalled':installedSkills=m.skills||[];renderInstalledSkills();if(marketplaceView.classList.contains('visible'))renderMarketplaceResults();break;case'marketplaceResults':{marketplaceBusy=false;marketplaceCards=(m.skills||[]).map(x=>({key:x.githubUrl||x.name,name:x.name,author:x.author||'',description:x.description||'',meta:(x.stars?String(x.stars)+' ★':'')+(x.author?' · '+esc(x.author):''),installed:installedMatch(x.author,x.name)}));marketplaceActions=(m.skills||[]).map(x=>({preview:x.githubUrl?{source:x.githubUrl,path:''}:null,install:x.githubUrl?{source:x.githubUrl,skill:undefined}:null}));marketplaceHeading=m.query?'Search results':'Popular skills';marketplaceHint=m.query?'Try another search to explore more.':'Search above to discover more skills.';marketplaceStatusText(m.query?'Found '+(m.total||(m.skills||[]).length)+' skills for "'+m.query+'".':'',true);renderMarketplaceResults();break}case'marketplaceRepoSkills':{marketplaceBusy=false;const source=m.owner+'/'+m.repo;marketplaceCards=(m.skills||[]).map(x=>({key:source+'/'+x.path,name:x.name,author:source,description:'',meta:'from '+esc(source),installed:installedMatch(source,x.name)}));marketplaceActions=(m.skills||[]).map(x=>({preview:{source,path:x.path},install:{source,skill:x.name}}));marketplaceHeading='Skills in '+source;marketplaceHint='Preview a skill before installing it.';marketplaceStatusText((m.skills||[]).length+' skills found.',true);renderMarketplaceResults();break}case'marketplacePreview':{previewContent.innerHTML=markdown(m.markdown||'');previewInstall.style.display='';document.getElementById('previewTitle').textContent=m.title||'Skill preview';break}case'marketplaceInstallProgress':{const st=marketplaceInstalling[m.key];if(st){st.done=m.done||0;st.total=m.total||0;st.label='Installing… '+(m.done||0)+'/'+(m.total||0)+' files';updateCardProgress(m.key);updatePreviewProgress(m.key)}break}case'marketplaceResult':{if(m.key)delete marketplaceInstalling[m.key];marketplaceStatusText(m.text,!!m.ok);if(m.ok){if(previewState&&previewState.key===m.key){closeSkillPreview()}if(marketplaceView.classList.contains('visible'))vscode.postMessage({type:'requestMarketplaceInstalled'})}else{if(previewState&&previewState.key===m.key){previewProgress.classList.add('visible','error');previewProgressFill.style.width='100%';previewProgressLabel.textContent=m.text||'Install failed.'}renderMarketplaceResults()}break}case'marketplaceError':{marketplaceBusy=false;marketplaceStatusText(m.text||'Request failed.',false);renderMarketplaceResults();break}
    case'usage':usageData=m;if(usageView.classList.contains('visible'))renderUsage();updateSessionStats();break;
    case'liveUsage':{if(m.conversationId&&m.inputTokens!==undefined&&m.outputTokens!==undefined){liveRuns.set(m.conversationId,{model:m.model||'',provider:m.provider||'',input:m.inputTokens||0,output:m.outputTokens||0,speed:m.speed||0})}else if(m.conversationId){liveRuns.delete(m.conversationId)}if(usageView.classList.contains('visible'))renderUsage();updateSessionStats();break}
    case'user':{liveByConversation.set(m.conversationId,freshLive());if(m.conversationId===activeConversationId)activeConversationItems.push(m.item);if(m.conversationId===activeConversationId){const tmpBubble=currentTurn?.querySelector('.user-text');if(currentTurn&&tmpBubble){const footer=currentTurn.querySelector('.message-footer');if(footer)footer.remove();currentTurn.appendChild(messageFooter(m.item,false))}else{beginTurn(m.item)}}break}
    case'resume':{const s=liveState(m.conversationId);s.phase='thinking';s.activity=null;s.currentRaw='';if(m.conversationId===activeConversationId){currentTurn=document.querySelector('.turn:last-child')||null;current=activity=activityBody=reasoning=null;followOutput=true;scroll(true)}break}
    case'workPhase':{const s=liveState(m.conversationId);s.phase='work';if(s.activity)s.activity.reasoningParts.push('');if(m.conversationId===activeConversationId)nextWorkPhase();break}
    case'delta':{const s=liveState(m.conversationId);s.currentRaw+=m.text;s.phase='text';closeLiveActivity(s);if(m.conversationId===activeConversationId&&currentTurn){if(!current)createTextSegment();current.dataset.raw+=m.text;current.innerHTML=markdown(current.dataset.raw);scroll()}break}
    case'reasoningDelta':{const s=liveState(m.conversationId);ensureLiveActivity(s);const parts=s.activity.reasoningParts;parts[parts.length-1]+=m.text;if(m.conversationId===activeConversationId&&currentTurn){ensureActivity();enableActivity();reasoning.dataset.raw+=m.text;reasoning.innerHTML=markdown(reasoning.dataset.raw);scrollActivity()}break}
    case'reasoningEnd':break;
    case'plan':{const s=liveState(m.conversationId);s.plan={title:m.title,steps:m.steps,activeStep:m.activeStep,doneSteps:m.doneSteps,interrupted:Boolean(m.interrupted),done:Boolean(m.done)};if(m.conversationId===activeConversationId)showPlan(m);break}
    case'subagent':{const s=liveState(m.conversationId);ensureLiveActivity(s);let sub=(s.activity.subagents||[]).find(x=>x.id===m.id);if(!sub){sub={id:m.id,role:m.role,name:m.name,done:false,ok:null,result:'',error:''};s.activity.subagents.push(sub);s.activity.taskCount++}sub.name=m.name||sub.name;sub.role=m.role||sub.role;sub.done=m.phase==='end';if(m.phase==='end'){sub.ok=m.ok!==false;sub.result=m.result||'';sub.error=m.error||''}s.activity.summary=m.phase==='start'?(m.name||'Subagent working'):'Working';if(m.conversationId===activeConversationId)updateSubagent(m);break}
    case'tool':{const s=liveState(m.conversationId);ensureLiveActivity(s);let row=s.activity.tasks.find(t=>t.id===m.id);if(row){row.name=m.name;row.done=m.phase==='end';row.failed=Boolean(m.failed);row.parentId=m.parentId||row.parentId;row.subagentRole=m.subagentRole||row.subagentRole}else{s.activity.tasks.push({id:m.id,name:m.name,done:m.phase==='end',failed:Boolean(m.failed),parentId:m.parentId||'',subagentRole:m.subagentRole||''});s.activity.taskCount++}s.activity.summary=m.phase==='start'?m.name:'Working';if(m.conversationId===activeConversationId)updateTask(m);break}
    case'retry':{const s=liveState(m.conversationId);ensureLiveActivity(s);s.activity.retries.push({attempt:m.attempt,max:m.max,ok:null,error:m.error||'',backoffMs:m.backoffMs||0});s.activity.taskCount++;s.activity.summary='Reconnecting '+m.attempt+'/'+m.max+(m.error?' ('+m.error+')':'');if(m.conversationId===activeConversationId)showRetry(m);break}
    case'retryEnd':{const s=liveState(m.conversationId);if(s.activity&&s.activity.retries.length){const last=s.activity.retries[s.activity.retries.length-1];last.ok=Boolean(m.ok)}if(m.conversationId===activeConversationId)finishRetry(m);break}
    case'changed':{const s=liveState(m.conversationId);ensureLiveActivity(s);s.activity.changed.push({text:(m.action||'Changed')+' '+m.path,path:m.path});if(m.conversationId===activeConversationId){if(!currentTurn)break;ensureActivity();enableActivity();const d=document.createElement('div');d.className='changed';d.textContent=(m.action||'Changed')+' '+m.path;d.onclick=()=>vscode.postMessage({type:'openFile',path:m.path});activityBody.appendChild(d);scrollActivity()}break}
    case'command':break;
    case'error':{if(m.conversationId){const s=liveState(m.conversationId);s.errorText=m.text;s.errorRetry=false;s.phase='error';closeLiveActivity(s);if(m.conversationId===activeConversationId){addError(m.text);finish()}}else{addError(m.text);finish()}break}
    case'steered':if(m.conversationId===activeConversationId)finish();break;
    case'generationError':liveByConversation.delete(m.conversationId);if(m.conversationId===activeConversationId){activeConversationItems.push(m.item);updateSessionStats();showGenerationError(m.item)}break;
    case'queuedPrompt':if(m.prompt)queuedByConversation.set(m.conversationId,m.prompt);else queuedByConversation.delete(m.conversationId);updateQueuedVisibility();break;
    case'state':if(m.running)runningSet.add(m.conversationId);else runningSet.delete(m.conversationId);modelButton.disabled=isRunning();updateSendMode();updateJump();break;
    case'notify':{const choice=await showNotifyModal({title:m.title,body:m.detail,ok:m.okLabel,cancel:m.cancelLabel,secondary:m.secondaryLabel,danger:Boolean(m.danger),risk:m.risk});vscode.postMessage({type:'notifyResponse',id:m.id,choice});break}
    case'done':liveByConversation.delete(m.conversationId);if(m.conversationId===activeConversationId){activeConversationItems.push(m.item);updateSessionStats();finish(m.item)}break;
  }})
  vscode.postMessage({type:'ready'});vscode.postMessage({type:'requestMarketplaceInstalled'})
`;
}
