function systemDialog(message, initial, mode) {
  return new Promise(resolve => {
    let settled=false;
    const finish=value=>{if(!settled){settled=true;resolve(value);}};
    const modal=openModal({title:mode==='prompt'?'Completar datos':'Confirmar acción',
      body:`<p>${esc(message)}</p>${mode==='prompt'?`<div class="field"><input id="dialog-value" value="${esc(initial||'')}"></div>`:''}`,
      footer:'<button class="btn" data-act="modal-close">Cancelar</button><button class="btn btn-primary" id="dialog-accept">Confirmar</button>',
      onClose:()=>finish(mode==='prompt'?null:false)});
    const accept=()=>{finish(mode==='prompt'?modal.root.querySelector('#dialog-value').value:true);modal.close();};
    modal.root.querySelector('#dialog-accept').onclick=accept;
    modal.root.querySelector('#dialog-value')?.addEventListener('keydown',e=>{if(e.key==='Enter'){e.preventDefault();e.stopPropagation();accept();}});
    setTimeout(()=>{if(modal.wrap.isConnected)(modal.root.querySelector('#dialog-value')||modal.root.querySelector('#dialog-accept')).focus();},70);
  });
}
function uiConfirm(message){return systemDialog(message,'','confirm');}
function uiPrompt(message,initial=''){return systemDialog(message,initial,'prompt');}

async function printerSettings() {
  const [config,sucursales]=await Promise.all([api('GET','/api/impresion/config'),api('GET','/api/sucursales/select')]);
  const modal=openModal({title:'Configurar impresión',wide:true,
    body:`<h3>Agente Windows</h3><p>Instala el agente en la PC conectada por USB. La cola debe aceptar comandos ZPL o TSPL sin convertirlos.</p>
      <div class="field"><span>Nombre de la PC</span><input id="agent-name"></div><div class="field"><span>Sucursal</span><select id="agent-branch">${sucursales.sucursales.map(s=>`<option value="${s.id}">${esc(s.nombre)}</option>`).join('')}</select></div><button class="btn" id="agent-create">Crear credencial</button><div id="agent-token"></div>
      <ul>${config.agents.map(a=>`<li>${esc(a.nombre)} · ${a.activo?'Activo':'Revocado'} · ${a.last_seen?`Última conexión: ${esc(a.last_seen)}`:'Sin conexión registrada'} ${a.activo?`<button class="btn" data-revoke-agent="${a.id}">Revocar</button>`:''}</li>`).join('')}</ul>
      <h3>Perfil de impresora · 100 × 150 mm</h3>
      <div class="field"><span>Perfil</span><select id="printer-existing"><option value="">Nueva impresora</option>${config.printers.map(p=>`<option value="${p.id}">${esc(p.nombre)}</option>`).join('')}</select></div>
      <div class="field"><span>Agente</span><select id="printer-agent">${config.agents.filter(a=>a.activo).map(a=>`<option value="${a.id}">${esc(a.nombre)}</option>`).join('')}</select></div>
      <div class="field"><span>Nombre</span><input id="printer-name"></div><div class="field"><span>Nombre exacto de la cola en Windows</span><input id="printer-queue"></div>
      <div class="field"><span>Lenguaje</span><select id="printer-language"><option>ZPL</option><option>TSPL</option></select></div>
      <div class="field"><span>Resolución</span><select id="printer-dpi"><option>203</option><option>300</option></select></div>
      <div class="field"><span>Ajuste horizontal (mm)</span><input id="printer-x" type="number" min="-5" max="5" step="0.1" value="0"></div>
      <div class="field"><span>Ajuste vertical (mm)</span><input id="printer-y" type="number" min="-5" max="5" step="0.1" value="0"></div>
      <div class="field"><span>Separación entre etiquetas (mm, TSPL)</span><input id="printer-gap" type="number" min="0" max="10" step="0.1" value="3"></div><p class="form-error" role="alert"></p>`,
    footer:'<button class="btn" data-act="modal-close">Cerrar</button><button class="btn btn-primary" id="printer-save">Guardar perfil</button>'});
  const el=id=>modal.root.querySelector('#'+id),error=modal.root.querySelector('.form-error');
  el('agent-create').onclick=async()=>{
    const b=el('agent-create');if(b.disabled)return;b.disabled=true;
    try{const result=await api('POST','/api/impresion/agentes',{nombre:el('agent-name').value,sucursal_id:Number(el('agent-branch').value)});
      el('agent-token').innerHTML=`<p>Guarda esta credencial: se muestra una sola vez. Configúrala como <code>AgentToken</code> en la PC.</p><textarea readonly aria-label="Credencial del agente">${esc(result.token)}</textarea>`;
      const option=new Option(el('agent-name').value,result.id);el('printer-agent').add(option);el('printer-agent').value=result.id;
    }catch(e){error.textContent=e.message;b.disabled=false;}
  };
  modal.root.querySelectorAll('[data-revoke-agent]').forEach(b=>b.onclick=async()=>{if(!await uiConfirm('¿Revocar el acceso de este agente?'))return;try{await api('DELETE',`/api/impresion/agentes/${b.dataset.revokeAgent}`);b.disabled=true;b.textContent='Revocado';}catch(e){error.textContent=e.message;}});
  el('printer-existing').onchange=()=>{
    const p=config.printers.find(p=>p.id===Number(el('printer-existing').value));if(!p)return;
    for(const [suffix,key]of Object.entries({agent:'agent_id',name:'nombre',queue:'queue_name',language:'language',dpi:'dpi',x:'offset_x',y:'offset_y',gap:'gap_mm'}))el('printer-'+suffix).value=p[key];
  };
  el('printer-save').onclick=async()=>{
    const b=el('printer-save');if(b.disabled)return;b.disabled=true;
    try{await api('POST','/api/impresion/impresoras',{id:Number(el('printer-existing').value)||undefined,agent_id:Number(el('printer-agent').value),nombre:el('printer-name').value,queue_name:el('printer-queue').value,language:el('printer-language').value,dpi:Number(el('printer-dpi').value),offset_x:Number(el('printer-x').value),offset_y:Number(el('printer-y').value),gap_mm:Number(el('printer-gap').value)});
      toast('Perfil guardado');modal.close();closeTopModal();await imprimirEtiquetas();
    }catch(e){error.textContent=e.message;b.disabled=false;}
  };
}
async function printJobs() {
  let timer;
  const reprintKeys=new Map();
  const modal=openModal({title:'Trabajos de impresión',wide:true,body:'<div id="print-job-list">Cargando…</div>',footer:'<button class="btn" data-act="modal-close">Cerrar</button>',onClose:()=>clearTimeout(timer)});
  const statuses={pending:'En cola',claimed:'Enviando',submitted:'Enviado a la impresora',uncertain:'Resultado incierto: verifica la impresora',failed:'No enviado'};
  async function refresh(){
    try{
      const {jobs}=await api('GET','/api/impresion/trabajos');if(!modal.wrap.isConnected)return;
      modal.root.querySelector('#print-job-list').innerHTML=jobs.length?jobs.map(j=>`<div class="card"><b>${esc(j.impresora)}</b><p>${esc(statuses[j.status]||j.status)} · ${esc(j.created_at)}</p>${j.error?`<p>${esc(j.error)}</p>`:''}${['submitted','uncertain','failed'].includes(j.status)?`<button class="btn" data-reprint="${j.id}">Reimprimir</button>`:''}</div>`).join(''):'No hay trabajos.';
      modal.root.querySelectorAll('[data-reprint]').forEach(b=>b.onclick=async()=>{
        if(!await uiConfirm('¿Crear una nueva impresión? Verifica que las etiquetas anteriores no hayan salido.'))return;
        b.disabled=true;
        try{if(!reprintKeys.has(b.dataset.reprint))reprintKeys.set(b.dataset.reprint,crypto.randomUUID());const j=jobs.find(j=>j.id===b.dataset.reprint),items=typeof j.items==='string'?JSON.parse(j.items):j.items;await api('POST','/api/impresion/trabajos',{request_key:reprintKeys.get(j.id),printer_id:j.printer_id,items:items.map(i=>({producto_id:i.id,copias:i.copias}))});reprintKeys.delete(j.id);await refresh();}
        catch(e){toast(e.message,'err');b.disabled=false;}
      });
    }catch(e){if(modal.wrap.isConnected)modal.root.querySelector('#print-job-list').textContent=e.message;}
    clearTimeout(timer);if(modal.wrap.isConnected)timer=setTimeout(refresh,3000);
  }
  await refresh();
}

async function openCameraScanner(input) {
  if(!navigator.mediaDevices?.getUserMedia){toast('La cámara necesita HTTPS y un navegador compatible. Puedes usar el lector o escribir el código.','err');return;}
  let controls,closed=false;
  const scanGate = createScanGate();
  const modal=openModal({title:'Escanear código',body:'<video id="scanner-video" autoplay muted playsinline style="width:100%;max-height:55vh"></video><p id="scanner-feedback" role="status">Apunta al código de barras.</p>',footer:'<button class="btn" data-act="modal-close">Cerrar cámara</button>',onClose:()=>{closed=true;controls?.stop();const video=modal.root.querySelector('video');video.srcObject?.getTracks().forEach(track=>track.stop());}});
  try {
    const reader=new ZXingBrowser.BrowserMultiFormatReader(undefined,{delayBetweenScanAttempts:150,delayBetweenScanSuccess:150});
    controls=await reader.decodeFromConstraints({video:{facingMode:{ideal:'environment'}},audio:false},modal.root.querySelector('video'),(result)=>{
      if(closed)return;
      if(!input.isConnected){modal.close();return;}
      if(!result) { scanGate.accept('',Date.now()); return; }
      const code=result.getText();
      if(!scanGate.accept(code))return;
      if(!/^\d+$/.test(code)){modal.root.querySelector('#scanner-feedback').textContent='El código debe ser numérico.';return;}
      input.value=code;input.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}));
      modal.root.querySelector('#scanner-feedback').textContent=`Leído: ${code}. Retira el código antes de repetirlo.`;
    });
    if(closed)controls.stop();
  }catch(e){if(!closed)modal.root.querySelector('#scanner-feedback').textContent=e.name==='NotAllowedError'?'Permite el acceso a la cámara para escanear.':'No se pudo abrir la cámara. Puedes usar el lector o escribir el código.';}
}
// Inputs are rendered dynamically by the existing screens.
new MutationObserver(()=>{
  for(const id of ['pos-buscar','esc-codigo','rec-codigo']){
    const input=document.getElementById(id);if(!input||input.dataset.cameraReady)continue;
    input.dataset.cameraReady='1';const b=document.createElement('button');b.type='button';b.className='btn camera-button';b.textContent='Escanear con cámara';
    b.onclick=()=>openCameraScanner(input);input.insertAdjacentElement('afterend',b);
  }
}).observe(document.body,{childList:true,subtree:true});
