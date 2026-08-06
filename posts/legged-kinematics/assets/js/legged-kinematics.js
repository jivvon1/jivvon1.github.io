(function () {
  'use strict';
  const root = document.querySelector('[data-kinematics-app]');
  if (!root) return;
  const canvas = root.querySelector('[data-world]');
  const ctx = canvas.getContext('2d');
  const $ = (q) => root.querySelector(q);
  const state = { command: 0, velocity: 0, turnCommand: 0, yawRate: 0, worldX: 0, worldZ: 0, heading: 0, phase: 0, paused: false, resumeCommand: 0.1, last: performance.now(), prevAngles: [[0,0],[0,0]], estimate: 0 };
  root.go2State = state;
  const L1 = 62, L2 = 64;
  const legVizRoot=root.querySelector('[data-leg-viz]');
  const xyCanvas=root.querySelector('[data-xy-chart]');
  const xyCtx=xyCanvas?xyCanvas.getContext('2d'):null;
  const freshEskf=()=>{const P=new Float64Array(225);for(let i=0;i<15;i++)P[i*15+i]=i<3?.015:i<9?.03:.002;return {q:[1,0,0,0],p:[0,0,0],v:[0,0,0],bg:[0,0,0],ba:[0,0,0],P};};
  const imu={prevVelocity:0,prevRoll:0,prevPitch:0,prevYaw:0,prevTruthZ:0,prevTruthVz:0,imuVelocity:0,correctedVelocity:0,time:0,history:[],imuYaw:0,imuQ:[1,0,0,0],imuVx:0,imuVy:0,imuVz:0,imuX:0,imuY:0,imuZ:0,kinX:0,kinY:0,kinZ:0,eskf:freshEskf(),contactUpdateTimer:0,lastInnovation:0,xyHistory:[],visibleTraces:{truth:true,kin:true,imu:false,ekf:true},posePlane:'xy',xyView:{centerX:1.15,centerY:0,rangeY:2,dragging:false,lastX:0,lastY:0}};
  root.querySelectorAll('[data-xy-trace-toggle]').forEach(button=>button.addEventListener('click',()=>{const key=button.dataset.xyTraceToggle;imu.visibleTraces[key]=!imu.visibleTraces[key];button.setAttribute('aria-pressed',String(imu.visibleTraces[key]));const label=button.querySelector('small');label.textContent=label.textContent.replace(/CLICK TO (?:HIDE|PLOT)/,imu.visibleTraces[key]?'CLICK TO HIDE':'CLICK TO PLOT');drawXyChart();}));
  root.querySelectorAll('[data-pose-plane]').forEach(button=>button.addEventListener('click',()=>{imu.posePlane=button.dataset.posePlane;root.querySelectorAll('[data-pose-plane]').forEach(item=>item.classList.toggle('is-active',item===button));root.querySelector('[data-pose-plane-label]').textContent=imu.posePlane.toUpperCase();resetXyView();updatePoseReadouts(v=>((v>=0?'+':'')+v.toFixed(2)));drawXyChart();}));
  root.querySelectorAll('[data-estimator-tab]').forEach(button=>button.addEventListener('click',()=>{const page=button.dataset.estimatorTab;root.querySelectorAll('[data-estimator-tab]').forEach(item=>{const active=item===button;item.classList.toggle('is-active',active);item.setAttribute('aria-selected',String(active));});root.querySelectorAll('[data-estimator-page]').forEach(panel=>{panel.hidden=panel.dataset.estimatorPage!==page;});if(page==='imu')requestAnimationFrame(drawXyChart);}));
  if(xyCanvas){
    xyCanvas.addEventListener('pointerdown',event=>{imu.xyView.dragging=true;imu.xyView.lastX=event.clientX;imu.xyView.lastY=event.clientY;xyCanvas.setPointerCapture(event.pointerId);});
    xyCanvas.addEventListener('pointermove',event=>{if(!imu.xyView.dragging)return;const rect=xyCanvas.getBoundingClientRect(),scale=(rect.height-48)/(2*imu.xyView.rangeY);imu.xyView.centerX-=(event.clientX-imu.xyView.lastX)/scale;imu.xyView.centerY+=(event.clientY-imu.xyView.lastY)/scale;imu.xyView.lastX=event.clientX;imu.xyView.lastY=event.clientY;drawXyChart();});
    const stopPan=()=>{imu.xyView.dragging=false;};
    xyCanvas.addEventListener('pointerup',stopPan);xyCanvas.addEventListener('pointercancel',stopPan);
    xyCanvas.addEventListener('wheel',event=>{event.preventDefault();const rect=xyCanvas.getBoundingClientRect(),oldScale=(rect.height-48)/(2*imu.xyView.rangeY),mx=event.clientX-rect.left,my=event.clientY-rect.top,worldX=imu.xyView.centerX+(mx-rect.width/2)/oldScale,worldY=imu.xyView.centerY-(my-rect.height/2)/oldScale;imu.xyView.rangeY=Math.max(.2,Math.min(20,imu.xyView.rangeY*Math.exp(event.deltaY*.001)));const newScale=(rect.height-48)/(2*imu.xyView.rangeY);imu.xyView.centerX=worldX-(mx-rect.width/2)/newScale;imu.xyView.centerY=worldY+(my-rect.height/2)/newScale;drawXyChart();},{passive:false});
    xyCanvas.addEventListener('dblclick',()=>{resetXyView();drawXyChart();});
  }
  function resetXyView(){imu.xyView.centerX=imu.posePlane==='xy'?1.15:.15;imu.xyView.centerY=0;imu.xyView.rangeY=imu.posePlane==='xy'?2:.25;}
  const legColors={FL:'#54a7ff',FR:'#f08b54',RL:'#9b7cff',RR:'#55c79a'};
  const legNames={FL:'FRONT LEFT',FR:'FRONT RIGHT',RL:'REAR LEFT',RR:'REAR RIGHT'};
  if(legVizRoot){
    legVizRoot.innerHTML=['FL','FR','RL','RR'].map(name=>
      '<article class="kin-leg-card'+(name==='FL'?' is-featured':'')+'" data-leg-card="'+name+'">'+
        '<header><strong><b>'+name+'</b><em>'+legNames[name]+'</em></strong><span data-leg-mode>STANCE</span></header>'+
        '<svg viewBox="0 0 150 142" role="img" aria-label="'+name+' foot to body kinematic chain">'+
          '<line class="kin-leg-ground" x1="12" y1="125" x2="138" y2="125"/>'+
          '<rect class="kin-leg-body" x="48" y="12" width="54" height="22" rx="6"/>'+
          '<text class="kin-leg-body-text" x="75" y="27">BODY</text>'+
          '<line class="kin-leg-link kin-leg-link--body" data-link-body x1="75" y1="34" x2="75" y2="40"/>'+
          '<line class="kin-leg-link kin-leg-link--hip-offset" data-link-hip x1="75" y1="40" x2="75" y2="49"/>'+
          '<line class="kin-leg-link kin-leg-link--upper" data-link-upper x1="75" y1="49" x2="75" y2="82"/>'+
          '<line class="kin-leg-link kin-leg-link--lower" data-link-lower x1="75" y1="76" x2="75" y2="118"/>'+
          '<circle class="kin-leg-joint kin-leg-joint--abad" data-joint-abad cx="75" cy="40" r="4"/>'+
          '<circle class="kin-leg-joint" data-joint-hip cx="75" cy="49" r="4"/>'+
          '<circle class="kin-leg-joint" data-joint-knee cx="75" cy="76" r="4"/>'+
          '<circle class="kin-leg-foot" data-joint-foot cx="75" cy="118" r="5"/>'+
          '<circle class="kin-leg-contact-pulse" data-contact-pulse cx="75" cy="125" r="10"/>'+
          '<text class="kin-leg-q" data-q-abad x="84" y="42">q₁ HAA 0°</text>'+
          '<text class="kin-leg-q" data-q-hip x="84" y="55">q₂ HFE 0°</text>'+
          '<text class="kin-leg-q" data-q-knee x="84" y="88">q₃ KFE 0°</text>'+
          '<text class="kin-chain-label" data-label-hip x="20" y="51">HIP</text>'+
          '<text class="kin-chain-label" data-label-knee x="20" y="88">KNEE</text>'+
          '<text class="kin-chain-label" data-label-foot x="20" y="120">FOOT</text>'+
          '<text class="kin-chain-index" data-index-foot x="58" y="137">CONTACT cᵢ</text>'+
          '<path class="kin-body-velocity" data-leg-velocity d="M105 22h27m-7-5 7 5-7 5"/>'+
          '<text class="kin-body-velocity-value" data-leg-velocity-value x="105" y="13">vᴮ +0.00 m/s</text>'+
        '</svg>'+
        '<div class="kin-leg-calculation">'+
          '<div><small>① JOINT INPUT</small><strong data-calc-q>q₂ 0.0° · q₃ 0.0°</strong><span data-calc-qd>q̇₂ 0.00 · q̇₃ 0.00 rad/s</span></div>'+
          '<div><small>② FORWARD KINEMATICS</small><strong data-calc-fk>x = 0.000 · z = 0.000 m</strong><span>x = l₁sin q₂ + l₂sin(q₂+q₃)</span></div>'+
          '<div><small>③ DIFFERENTIATE</small><strong data-calc-jqd>J(q)q̇ = +0.00 m/s</strong><span>foot velocity relative to body</span></div>'+
          '<div data-calc-result><small>④ CONTACT CONSTRAINT</small><strong data-calc-vb>vᴮ = +0.00 m/s</strong><span data-calc-rule>vᴮ = −J(q)q̇</span></div>'+
        '</div>'+
        '<footer><code>0 = v<sub>B</sub> + J<sub>'+name+'</sub>(q)q̇</code><span data-chain-state>CONSTRAINED</span></footer>'+
      '</article>').join('');
    function selectLeg(name){
      legVizRoot.querySelectorAll('[data-leg-card]').forEach(card=>{
        const selected=card.dataset.legCard===name;
        card.classList.toggle('is-featured',selected);
      });
    }
    Object.entries(legColors).forEach(([name,color])=>{
      const card=legVizRoot.querySelector('[data-leg-card="'+name+'"]');
      card.style.setProperty('--leg-color',color);
      card.addEventListener('click',()=>selectLeg(name));
    });
    selectLeg('FL');
  }

  function sizeCanvas() {
    const r = canvas.getBoundingClientRect();
    const dpr = Math.min(devicePixelRatio || 1, 2);
    canvas.width = Math.round(r.width * dpr); canvas.height = Math.round(r.height * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }
  function css(name) { return getComputedStyle(document.documentElement).getPropertyValue(name).trim(); }
  function legIK(dx, dy) {
    const d = Math.min(L1 + L2 - 1, Math.max(22, Math.hypot(dx, dy)));
    const knee = Math.acos(Math.max(-1, Math.min(1, (L1*L1 + L2*L2 - d*d)/(2*L1*L2))));
    const hip = Math.atan2(dx, dy) - Math.acos(Math.max(-1, Math.min(1, (L1*L1 + d*d - L2*L2)/(2*L1*d))));
    return [hip, Math.PI - knee];
  }
  function point(x,y,r,color) { ctx.beginPath(); ctx.arc(x,y,r,0,Math.PI*2); ctx.fillStyle=color; ctx.fill(); }
  function line(a,b,color,width) { ctx.beginPath(); ctx.moveTo(a.x,a.y); ctx.lineTo(b.x,b.y); ctx.strokeStyle=color; ctx.lineWidth=width; ctx.lineCap='round'; ctx.stroke(); }
  function arrow(x,y,dx,color) {
    if (Math.abs(dx) < 3) return;
    ctx.strokeStyle=color; ctx.fillStyle=color; ctx.lineWidth=2; ctx.beginPath(); ctx.moveTo(x,y); ctx.lineTo(x+dx,y); ctx.stroke();
    const s=Math.sign(dx); ctx.beginPath(); ctx.moveTo(x+dx,y); ctx.lineTo(x+dx-8*s,y-5); ctx.lineTo(x+dx-8*s,y+5); ctx.closePath(); ctx.fill();
  }
  function gait() {
    const moving = Math.abs(state.velocity) > .035;
    const cycle = state.phase % (Math.PI*2);
    const leftStance = !moving || Math.sin(cycle) >= -.12;
    const rightStance = !moving || Math.sin(cycle) <= .12;
    function foot(offset) {
      if (!moving) return { x: offset ? 33 : -33, lift: 0 };
      const p = (cycle + (offset ? Math.PI : 0)) % (Math.PI*2);
      return { x: -Math.cos(p) * 42 * Math.sign(state.velocity || 1), lift: Math.max(0, -Math.sin(p)) * 28 };
    }
    const result = { contacts:[leftStance,rightStance], feet:[foot(0),foot(1)] };
    root.go2Gait = result;
    return result;
  }
  function render(dt) {
    const w=canvas.clientWidth, h=canvas.clientHeight, ground=h-54, bodyY=ground-132;
    ctx.clearRect(0,0,w,h);
    const text=css('--text-primary'), muted=css('--text-muted'), border=css('--border'), accent=css('--accent'), bg=css('--bg-card');
    ctx.strokeStyle=border; ctx.lineWidth=1; ctx.setLineDash([4,7]);
    for(let x=18;x<w;x+=42){ctx.beginPath();ctx.moveTo(x,24);ctx.lineTo(x,ground);ctx.stroke();}
    for(let y=30;y<ground;y+=42){ctx.beginPath();ctx.moveTo(0,y);ctx.lineTo(w,y);ctx.stroke();}
    ctx.setLineDash([]); ctx.strokeStyle=muted; ctx.lineWidth=2; ctx.beginPath(); ctx.moveTo(0,ground);ctx.lineTo(w,ground);ctx.stroke();
    for(let x=10;x<w;x+=24){ctx.beginPath();ctx.moveTo(x,ground);ctx.lineTo(x-8,ground+10);ctx.stroke();}

    const g=gait(), cx=w/2, bodyBob=Math.abs(state.velocity)>.03 ? Math.sin(state.phase*2)*3 : 0;
    const hipCenters=[{x:cx-22,y:bodyY+bodyBob},{x:cx+22,y:bodyY+bodyBob}];
    const angles=[];
    g.feet.forEach((f,i)=>{
      const foot={x:cx+f.x,y:ground-f.lift}; const hip=hipCenters[i]; const a=legIK(foot.x-hip.x, foot.y-hip.y); angles.push(a);
      const knee={x:hip.x+Math.sin(a[0])*L1,y:hip.y+Math.cos(a[0])*L1};
      line(hip,knee,i===0?'#54a7ff':'#f08b54',9); line(knee,foot,i===0?'#54a7ff':'#f08b54',8);
      point(hip.x,hip.y,6,bg); point(hip.x,hip.y,4,text); point(knee.x,knee.y,6,bg); point(knee.x,knee.y,4,text);
      ctx.strokeStyle=g.contacts[i]?accent:muted; ctx.lineWidth=5; ctx.beginPath();ctx.moveTo(foot.x-12,foot.y);ctx.lineTo(foot.x+14,foot.y);ctx.stroke();
      if(g.contacts[i]){ctx.fillStyle=accent;ctx.globalAlpha=.14;ctx.fillRect(foot.x-20,ground-5,40,12);ctx.globalAlpha=1;}
    });
    ctx.fillStyle=text; ctx.beginPath();ctx.roundRect(cx-47,bodyY-34+bodyBob,94,55,13);ctx.fill();
    ctx.fillStyle=accent;ctx.beginPath();ctx.roundRect(cx-31,bodyY-21+bodyBob,62,5,3);ctx.fill();
    ctx.fillStyle=bg;ctx.font='600 10px Montserrat';ctx.textAlign='center';ctx.fillText('BASE',cx,bodyY+5+bodyBob);
    arrow(cx,bodyY-48,state.velocity*55,accent);
    ctx.fillStyle=muted;ctx.font='500 10px Montserrat';ctx.fillText('v BODY',cx,bodyY-59);

    const stanceIndex = g.contacts[0] && !g.contacts[1] ? 0 : g.contacts[1] && !g.contacts[0] ? 1 : Math.abs(Math.sin(state.phase))>.1 ? (Math.sin(state.phase)>0?0:1) : 0;
    const a=angles[stanceIndex], prev=state.prevAngles[stanceIndex], rates=[(a[0]-prev[0])/Math.max(dt,.001),(a[1]-prev[1])/Math.max(dt,.001)];
    state.prevAngles=angles.map(v=>v.slice());
    const noisy = state.velocity + Math.sin(state.phase*4)*.012*Math.min(1,Math.abs(state.velocity)*3);
    state.estimate += (noisy-state.estimate)*Math.min(1,dt*8);
    updateReadout(g, stanceIndex, a, rates);
  }
  function updateReadout(g, idx, a, rates) {
    const deg=(x)=>x*180/Math.PI;
    const telemetry=root.go2Telemetry;
    const contacts=telemetry?telemetry.contacts:[g.contacts[0],g.contacts[1],g.contacts[1],g.contacts[0]];
    if(telemetry){ idx=telemetry.selected===0||telemetry.selected===3?0:1; a=[telemetry.q[1],-telemetry.q[2]]; rates=[telemetry.qd[1],-telemetry.qd[2]]; }
    const turning=Math.abs(state.yawRate)>.04?(state.yawRate>0?' · turning left':' · turning right'):'';
    $('[data-status]').textContent=state.paused?'Paused':Math.abs(state.velocity)<.03?('Standing'+turning):(state.velocity>0?'Forward':'Reverse')+turning;
    const count=contacts.filter(Boolean).length;
    $('[data-contact-badge]').textContent=count===4?'ALL':count+' CONTACT'+(count===1?'':'S');
    [['fl',0],['fr',1],['rl',2],['rr',3]].forEach(([n,i])=>{ const on=contacts[i]; $('[data-'+n+'-contact]').textContent=on?'STANCE':'SWING'; const c=root.querySelector('[data-foot-card="'+n+'"]'); c.classList.toggle('is-contact',on); });
    const abad=telemetry?telemetry.q[0]:.025*Math.cos(state.phase)*(Math.abs(state.velocity)>.035?1:0), abadRate=telemetry?telemetry.qd[0]:-.025*Math.sin(state.phase)*(2.2+Math.abs(state.velocity)*3.4);
    $('[data-abad-angle]').textContent=(deg(abad)>=0?'+':'')+deg(abad).toFixed(1)+'°';
    $('[data-abad-rate]').textContent='q̇₁ '+abadRate.toFixed(2)+' rad/s';
    $('[data-abad-meter]').style.transform='scaleX('+Math.min(1,Math.abs(deg(abad))/15)+')';
    $('[data-hip-angle]').textContent=(deg(a[0])>=0?'+':'')+deg(a[0]).toFixed(1)+'°';
    $('[data-knee-angle]').textContent=deg(a[1]).toFixed(1)+'°';
    $('[data-hip-rate]').textContent='q̇₂ '+rates[0].toFixed(2)+' rad/s'; $('[data-knee-rate]').textContent='q̇₃ '+rates[1].toFixed(2)+' rad/s';
    $('[data-hip-meter]').style.transform='scaleX('+Math.min(1,Math.abs(deg(a[0]))/50)+')'; $('[data-knee-meter]').style.transform='scaleX('+Math.min(1,Math.abs(deg(a[1]))/110)+')';
    const fusion=updateContactFusion(telemetry);
    const shownEstimate=fusion?fusion.value:state.estimate;
    const fmt=(v)=>(v>=0?'+':'')+v.toFixed(2); $('[data-estimate]').textContent=fmt(shownEstimate); $('[data-command]').textContent=fmt(state.command);
    $('[data-velocity-arrow]').style.transform='scaleX('+(shownEstimate<-.02?-1:1)+')';
    $('[data-confidence]').textContent=fusion?fusion.confidence:(g.contacts.some(Boolean)?'HIGH':'LOW');
    root.fusedEstimate=shownEstimate;
    updateLegVisuals(telemetry);
  }
  function updateContactFusion(telemetry){
    if(!telemetry||!telemetry.legs)return null;
    const active=telemetry.legs.filter(leg=>leg.contact&&Number.isFinite(leg.vb));
    const values=active.map(leg=>leg.vb).sort((a,b)=>a-b);
    const middle=Math.floor(values.length/2);
    const median=!values.length?0:(values.length%2?values[middle]:(values[middle-1]+values[middle])*.5);
    const weighted=active.map(leg=>{
      const residual=Math.abs(leg.vb-median);
      return {name:leg.name,value:leg.vb,weight:1/(1+Math.pow(residual/.12,2)),residual};
    });
    const weightSum=weighted.reduce((sum,item)=>sum+item.weight,0);
    const rawFused=weightSum?weighted.reduce((sum,item)=>sum+item.value*item.weight,0)/weightSum:0;
    const spread=weighted.length?Math.sqrt(weighted.reduce((sum,item)=>sum+item.weight*Math.pow(item.value-rawFused,2),0)/Math.max(weightSum,.001)):0;
    root.fusedVelocity=(root.fusedVelocity==null?rawFused:root.fusedVelocity+(rawFused-root.fusedVelocity)*.14);
    const rows={};weighted.forEach(item=>rows[item.name]=item);
    const medianOutput=root.querySelector('[data-median]');
    if(medianOutput)medianOutput.textContent=(median>=0?'+':'')+median.toFixed(2);
    telemetry.legs.forEach(leg=>{
      const item=rows[leg.name];
      const row=root.querySelector('[data-contact-estimate="'+leg.name+'"]');
      if(row){
        row.classList.toggle('is-active',!!item);
        row.querySelector('[data-contact-value]').textContent=item?((item.value>=0?'+':'')+item.value.toFixed(2)+' m/s'):'—';
        row.querySelector('[data-contact-weight]').textContent='w '+(item?item.weight.toFixed(2):'0.00');
        row.querySelector('span i').style.width=(item?item.weight*100:0)+'%';
      }
      const residualRow=root.querySelector('[data-residual-row="'+leg.name+'"]');
      if(residualRow){
        residualRow.classList.toggle('is-active',!!item);
        residualRow.querySelector('[data-residual-value]').textContent=item?item.residual.toFixed(3)+' m/s':'—';
        residualRow.querySelector('[data-residual-weight]').textContent=item?item.weight.toFixed(2):'0.00';
      }
    });
    const count=root.querySelector('[data-fusion-count]');if(count)count.textContent=active.length+' ACTIVE';
    return {value:root.fusedVelocity,confidence:active.length<1?'LOW':spread<.08?'HIGH':spread<.18?'MED':'LOW'};
  }
  function updateLegVisuals(telemetry){
    if(!legVizRoot||!telemetry||!telemetry.legs)return;
    const scale=43, abadX=75, abadY=39, hipY=44;
    telemetry.legs.forEach(leg=>{
      const card=legVizRoot.querySelector('[data-leg-card="'+leg.name+'"]'); if(!card)return;
      const q1=leg.q[0],q2=leg.q[1],q3=leg.q[2];
      const hipX=abadX+Math.sin(q1)*22;
      const kneeX=hipX+Math.sin(q2)*scale, kneeY=hipY+Math.cos(q2)*scale;
      const footX=kneeX+Math.sin(q2+q3)*scale, footY=kneeY+Math.cos(q2+q3)*scale;
      const groundY=125, dy=groundY-footY;
      const ky=kneeY+dy, hy=hipY+dy, ay=Math.min(hy-7,abadY+Math.max(0,dy*.25));
      const bodyLink=card.querySelector('[data-link-body]'),hipLink=card.querySelector('[data-link-hip]'),upper=card.querySelector('[data-link-upper]'),lower=card.querySelector('[data-link-lower]');
      bodyLink.setAttribute('x2',abadX);bodyLink.setAttribute('y2',ay);
      hipLink.setAttribute('x1',abadX);hipLink.setAttribute('y1',ay);hipLink.setAttribute('x2',hipX);hipLink.setAttribute('y2',hy);
      upper.setAttribute('x1',hipX);upper.setAttribute('y1',hy);upper.setAttribute('x2',kneeX);upper.setAttribute('y2',ky);
      lower.setAttribute('x1',kneeX);lower.setAttribute('y1',ky);lower.setAttribute('x2',footX);lower.setAttribute('y2',groundY);
      card.querySelector('[data-joint-abad]').setAttribute('cx',abadX);card.querySelector('[data-joint-abad]').setAttribute('cy',ay);
      card.querySelector('[data-joint-hip]').setAttribute('cx',hipX);card.querySelector('[data-joint-hip]').setAttribute('cy',hy);
      card.querySelector('[data-joint-knee]').setAttribute('cx',kneeX);card.querySelector('[data-joint-knee]').setAttribute('cy',ky);
      card.querySelector('[data-joint-foot]').setAttribute('cx',footX);card.querySelector('[data-joint-foot]').setAttribute('cy',groundY);
      card.querySelector('[data-contact-pulse]').setAttribute('cx',footX);card.querySelector('[data-contact-pulse]').setAttribute('cy',groundY);
      const qAbad=card.querySelector('[data-q-abad]'),qHip=card.querySelector('[data-q-hip]'),qKnee=card.querySelector('[data-q-knee]');
      qAbad.setAttribute('x',Math.min(98,abadX+7));qAbad.setAttribute('y',ay-3);qAbad.textContent='q₁ HAA '+Math.round(q1*180/Math.PI)+'°';
      qHip.setAttribute('x',Math.min(106,hipX+12));qHip.setAttribute('y',hy+3);qHip.textContent='q₂ HFE '+Math.round(q2*180/Math.PI)+'°';
      qKnee.setAttribute('x',Math.min(112,kneeX+16));qKnee.setAttribute('y',ky+3);qKnee.textContent='q₃ KFE '+Math.round(q3*180/Math.PI)+'°';
      card.classList.toggle('is-contact',leg.contact);
      card.querySelector('[data-leg-mode]').textContent=leg.contact?'STANCE':'SWING';
      card.querySelector('[data-chain-state]').textContent=leg.contact?'CONSTRAINED':'OPEN CHAIN';
      card.querySelector('[data-index-foot]').textContent=leg.contact?'CONTACT cᵢ = 1':'CONTACT cᵢ = 0';
      const l1=.213,l2=.236,qd2=leg.qd[1],qd3=leg.qd[2],sum=q2+q3;
      const footForward=l1*Math.sin(q2)+l2*Math.sin(sum),footDown=l1*Math.cos(q2)+l2*Math.cos(sum);
      const relativeVelocity=l1*Math.cos(q2)*qd2+l2*Math.cos(sum)*(qd2+qd3);
      const bodyVelocity=Number.isFinite(leg.vb)?leg.vb:-relativeVelocity;
      const formatSigned=(v,d)=>(v>=0?'+':'')+v.toFixed(d);
      card.querySelector('[data-calc-q]').textContent='q₂ '+formatSigned(q2*180/Math.PI,1)+'° · q₃ '+formatSigned(q3*180/Math.PI,1)+'°';
      card.querySelector('[data-calc-qd]').textContent='q̇₂ '+formatSigned(qd2,2)+' · q̇₃ '+formatSigned(qd3,2)+' rad/s';
      card.querySelector('[data-calc-fk]').textContent='x '+formatSigned(footForward,3)+' · z −'+Math.abs(footDown).toFixed(3)+' m';
      card.querySelector('[data-calc-jqd]').textContent='J(q)q̇ = '+formatSigned(relativeVelocity,2)+' m/s';
      card.querySelector('[data-calc-vb]').textContent=leg.contact?'vᴮ = '+formatSigned(bodyVelocity,2)+' m/s':'vᴮ unavailable';
      card.querySelector('[data-calc-rule]').textContent=leg.contact?'vᴮ = −J(q)q̇':'no zero-velocity constraint in swing';
      card.querySelector('[data-calc-result]').classList.toggle('is-disabled',!leg.contact);
      const arrow=card.querySelector('[data-leg-velocity]'),arrowValue=card.querySelector('[data-leg-velocity-value]');
      const shownVelocity=leg.contact?bodyVelocity:(root.fusedEstimate??state.estimate);
      const arrowLength=Math.max(6,Math.min(28,Math.abs(shownVelocity)*150)),arrowStart=105,arrowEnd=arrowStart+Math.sign(shownVelocity||1)*arrowLength,head=Math.sign(shownVelocity||1)*6;
      arrow.setAttribute('d','M'+arrowStart+' 22H'+arrowEnd+' M'+(arrowEnd-head)+' 17L'+arrowEnd+' 22L'+(arrowEnd-head)+' 27');
      arrowValue.setAttribute('x',Math.min(105,arrowEnd));
      arrowValue.textContent='vᴮ '+formatSigned(shownVelocity,2)+' m/s';
    });
  }
  function tick(now) {
    const dt=Math.min(.04,(now-state.last)/1000); state.last=now;
    // Paused = hard freeze: skip physics, rendering and estimator so every value + pose holds exactly.
    if(!state.paused){
      state.velocity+=(state.command-state.velocity)*Math.min(1,dt*3.5);
      state.yawRate+=(state.turnCommand-state.yawRate)*Math.min(1,dt*8);
      state.heading+=state.yawRate*dt;
      state.worldX+=Math.cos(state.heading)*state.velocity*dt;
      state.worldZ-=Math.sin(state.heading)*state.velocity*dt;
      state.phase+=dt*(2.2+Math.abs(state.velocity)*3.4);
      render(dt); updateVirtualImu(dt);
    }
    requestAnimationFrame(tick);
  }
  function updateVirtualImu(dt){
    if(dt<=0)return;
    const moving=Math.abs(state.velocity)>.02;
    // While the robot is standing still, freeze the whole estimator: no IMU integration,
    // no EKF predict/update, no trajectory growth. Every readout holds the value it had when it stopped.
    if(!moving){
      imu.prevVelocity=state.velocity;imu.prevRoll=0;imu.prevPitch=0;imu.prevYaw=state.heading;imu.prevTruthZ=0;imu.prevTruthVz=0;
      return;
    }
    imu.time+=dt;
    const roll=moving?.026*Math.sin(state.phase):0;
    const pitch=moving?.018*Math.sin(state.phase*2+.4):0;
    const yaw=state.heading;
    const rollRate=(roll-imu.prevRoll)/dt,pitchRate=(pitch-imu.prevPitch)/dt,yawRate=(yaw-imu.prevYaw)/dt;
    const trueForwardAcceleration=(state.velocity-imu.prevVelocity)/dt;
    const gyroBias=[.0008,-.0006,.0005],accelBias=.002;
    const gyro=[rollRate+gyroBias[0]+.012*Math.sin(imu.time*17),pitchRate+gyroBias[1]+.012*Math.sin(imu.time*13+1),yawRate+gyroBias[2]+.009*Math.sin(imu.time*11+2)];
    const measuredForwardAcceleration=trueForwardAcceleration+accelBias+.009*Math.sin(imu.time*19)+.005*Math.sin(imu.time*7);
    // Sensor convention: x-forward, y-left, z-up. Three.js remains Y-up internally.
    const truthZ=moving?.012*Math.sin(state.phase*2):0,truthVz=(truthZ-imu.prevTruthZ)/dt,trueVerticalAcceleration=(truthVz-imu.prevTruthVz)/dt;
    const measuredVerticalAcceleration=trueVerticalAcceleration+.004+.012*Math.sin(imu.time*23);
    const lateralAcceleration=state.velocity*state.yawRate,cy=Math.cos(yaw),sy=Math.sin(yaw),truthQ=quatFromEuler(roll,pitch,yaw);
    const idealSpecific=rotateInv(truthQ,[cy*trueForwardAcceleration-sy*lateralAcceleration,sy*trueForwardAcceleration+cy*lateralAcceleration,trueVerticalAcceleration+9.81]);
    const accel=[idealSpecific[0]+accelBias+.060*Math.sin(imu.time*19),idealSpecific[1]+.030*Math.sin(imu.time*15),idealSpecific[2]+.004+.075*Math.sin(imu.time*23)];
    imu.imuVelocity+=measuredForwardAcceleration*dt;
    imu.correctedVelocity+=measuredForwardAcceleration*dt;
    const telemetry=root.go2Telemetry;
    const hasContact=!!(telemetry&&telemetry.legs&&telemetry.legs.some(leg=>leg.contact));
    const contactVelocity=root.fusedEstimate;
    const residual=hasContact&&Number.isFinite(contactVelocity)?contactVelocity-imu.correctedVelocity:0;
    if(hasContact&&Number.isFinite(contactVelocity))imu.correctedVelocity+=residual*(1-Math.exp(-dt*7));
    const signed=(v,d=2)=>(v>=0?'+':'')+v.toFixed(d);
    root.querySelector('[data-imu-position]').textContent='x '+signed(state.worldX)+' · y '+signed(-state.worldZ)+' · z +0.00 m';
    root.querySelector('[data-imu-orientation]').textContent='r '+signed(roll*180/Math.PI,1)+'° · p '+signed(pitch*180/Math.PI,1)+'° · y '+signed(yaw*180/Math.PI,1)+'°';
    root.querySelector('[data-imu-gyro]').textContent='ω ['+gyro.map(v=>signed(v)).join(', ')+']';
    root.querySelector('[data-imu-accel]').textContent='a ['+accel.map(v=>signed(v)).join(', ')+']';
    root.querySelector('[data-imu-contact-state]').textContent=hasContact?'CONTACT UPDATE':'IMU ONLY';
    updateXyOdometry(dt,gyro,accel,hasContact,contactVelocity,truthZ,truthVz,signed);
    imu.prevVelocity=state.velocity;imu.prevRoll=roll;imu.prevPitch=pitch;imu.prevYaw=yaw;imu.prevTruthZ=truthZ;imu.prevTruthVz=truthVz;
  }
  function updateXyOdometry(dt,gyro,accel,hasContact,contactVelocity,truthZ,truthVz,signed){
    if(!xyCanvas)return;
    imu.imuYaw+=gyro[2]*dt;
    imu.imuQ=quatNormalize(quatMultiply(imu.imuQ,quatExp(gyro.map(v=>v*dt))));
    const openWorldSpecific=rotate(imu.imuQ,accel),worldAx=openWorldSpecific[0],worldAy=openWorldSpecific[1],worldAz=openWorldSpecific[2]-9.81;
    imu.imuX+=imu.imuVx*dt+.5*worldAx*dt*dt;imu.imuY+=imu.imuVy*dt+.5*worldAy*dt*dt;
    imu.imuZ+=imu.imuVz*dt+.5*worldAz*dt*dt;imu.imuVx+=worldAx*dt;imu.imuVy+=worldAy*dt;imu.imuVz+=worldAz*dt;
    if(hasContact&&Number.isFinite(contactVelocity)){
      imu.kinX+=Math.cos(imu.imuYaw)*contactVelocity*dt;
      imu.kinY+=Math.sin(imu.imuYaw)*contactVelocity*dt;
      imu.kinZ+=truthVz*dt+.0005*Math.sin(imu.time*9)*dt;
    }
    eskfPredict(imu.eskf,gyro,accel,dt);
    let innovation=imu.lastInnovation;
    imu.contactUpdateTimer+=dt;
    if(hasContact&&Number.isFinite(contactVelocity)&&imu.contactUpdateTimer>=.05){
      imu.contactUpdateTimer%=.05;
      const priorPosition=imu.eskf.p.slice(),measurement=[contactVelocity,0,truthVz],update=eskfVelocityUpdate(imu.eskf,measurement,[.004,.006,.004]);
      const predicted=update.predicted;
      innovation=Math.hypot(...update.innovation);imu.lastInnovation=innovation;
      root.querySelector('[data-ekf-update-state]').textContent='CONTACT UPDATE';
      root.querySelector('[data-ekf-prediction]').textContent='v⁻ ['+predicted.map(v=>signed(v)).join(', ')+']';
      root.querySelector('[data-ekf-prior-pose]').textContent='p⁻ ['+priorPosition.map(v=>signed(v)).join(', ')+']';
      root.querySelector('[data-ekf-measurement]').textContent='z ['+measurement.map(v=>signed(v)).join(', ')+']';
      root.querySelector('[data-ekf-innovation-vector]').textContent='r ['+update.innovation.map(v=>signed(v,3)).join(', ')+']';
      root.querySelector('[data-ekf-innovation-value]').textContent='‖r‖ = '+innovation.toFixed(3)+' m/s';
      root.querySelector('[data-ekf-gain]').textContent='‖K cols‖ ['+update.gainNorms.map(v=>v.toFixed(2)).join(', ')+']';
      root.querySelector('[data-ekf-posterior]').textContent='v⁺ ['+rotateInv(imu.eskf.q,imu.eskf.v).map(v=>signed(v)).join(', ')+']';
      root.querySelector('[data-ekf-posterior-state]').textContent='p⁺ ['+imu.eskf.p.map(v=>signed(v)).join(', ')+'] · bₐ⁺ ['+imu.eskf.ba.map(v=>signed(v,3)).join(', ')+']';
    }else if(!hasContact){
      root.querySelector('[data-ekf-update-state]').textContent='PREDICT ONLY';
    }
    const truthX=state.worldX,truthY=-state.worldZ;
    root.querySelector('[data-xy-innovation]').textContent='velocity innovation '+innovation.toFixed(3)+' m/s';
    imu.xyHistory.push({truth:[truthX,truthY,truthZ],kin:[imu.kinX,imu.kinY,imu.kinZ],imu:[imu.imuX,imu.imuY,imu.imuZ],ekf:imu.eskf.p.slice()});
    if(imu.xyHistory.length>6000)imu.xyHistory.shift();
    updatePoseReadouts(signed);
    drawXyChart();
  }
  function updatePoseReadouts(signed){
    const axes=imu.posePlane==='xy'?[0,1]:imu.posePlane==='xz'?[0,2]:[1,2],labels=imu.posePlane.split('');
    const values={truth:[state.worldX,-state.worldZ,imu.prevTruthZ],kin:[imu.kinX,imu.kinY,imu.kinZ],imu:[imu.imuX,imu.imuY,imu.imuZ],ekf:imu.eskf.p};
    Object.keys(values).forEach(key=>{root.querySelector('[data-xy-'+key+']').textContent=labels[0]+' '+signed(values[key][axes[0]])+' · '+labels[1]+' '+signed(values[key][axes[1]])+' m';});
  }
  function eskfPredict(filter,gyro,accel,dt){
    const omega=gyro.map((v,i)=>v-filter.bg[i]),specific=accel.map((v,i)=>v-filter.ba[i]);
    const worldSpecific=rotate(filter.q,specific),worldA=[worldSpecific[0],worldSpecific[1],worldSpecific[2]-9.81];
    for(let i=0;i<3;i++){filter.p[i]+=filter.v[i]*dt+.5*worldA[i]*dt*dt;filter.v[i]+=worldA[i]*dt;}
    filter.q=quatNormalize(quatMultiply(filter.q,quatExp(omega.map(v=>v*dt))));
    const F=identityMatrix(15),sw=skew(omega),sa=skew(specific),R=quatMatrix(filter.q);
    for(let r=0;r<3;r++)for(let c=0;c<3;c++){
      F[r*15+c]+=-sw[r*3+c]*dt;
      F[r*15+(9+c)]+=(r===c?-dt:0);
      F[(3+r)*15+(6+c)]+=(r===c?dt:0);
      let rsa=0;for(let k=0;k<3;k++)rsa+=R[r*3+k]*sa[k*3+c];
      F[(6+r)*15+c]+=-rsa*dt;
      F[(6+r)*15+(12+c)]+=-R[r*3+c]*dt;
    }
    const FP=matMul(F,filter.P,15,15,15),next=matMul(FP,matTranspose(F,15,15),15,15,15);
    const noise=[2e-5,2e-5,2e-5,2e-6,2e-6,2e-6,8e-4,8e-4,8e-4,2e-7,2e-7,2e-7,3e-6,3e-6,3e-6];
    for(let i=0;i<15;i++)next[i*15+i]+=noise[i]*dt;
    filter.P=next;
  }
  function eskfVelocityUpdate(filter,measurement,variances){
    const predicted=rotateInv(filter.q,filter.v),H=new Float64Array(45),Rt=matTranspose(quatMatrix(filter.q),3,3);
    // orientation is gyro-only: velocity update observes velocity error alone (no attitude block),
    // so S never inflates from the un-corrected attitude covariance
    for(let r=0;r<3;r++)for(let c=0;c<3;c++){H[r*15+6+c]=Rt[r*3+c];}
    const innovation=measurement.map((v,i)=>v-predicted[i]),HP=matMul(H,filter.P,3,15,15),S=matMul(HP,matTranspose(H,3,15),3,15,3);
    for(let i=0;i<3;i++)S[i*3+i]+=variances[i];
    const Sinv=invert3(S),PHt=matMul(filter.P,matTranspose(H,3,15),15,15,3),K=matMul(PHt,Sinv,15,3,3),dx=new Array(15).fill(0);
    for(let i=0;i<9;i++)K[i]=0; // decouple attitude: velocity update never rotates orientation — heading is gyro-only
    for(let r=0;r<15;r++)for(let c=0;c<3;c++)dx[r]+=K[r*3+c]*innovation[c];
    filter.q=quatNormalize(quatMultiply(filter.q,quatExp(dx.slice(0,3))));
    for(let i=0;i<3;i++){filter.p[i]+=dx[3+i];filter.v[i]+=dx[6+i];filter.bg[i]+=dx[9+i];filter.ba[i]+=dx[12+i];}
    const KH=matMul(K,H,15,3,15),I=identityMatrix(15);for(let i=0;i<225;i++)I[i]-=KH[i];
    filter.P=matMul(I,filter.P,15,15,15);
    for(let r=0;r<15;r++)for(let c=r+1;c<15;c++){const value=.5*(filter.P[r*15+c]+filter.P[c*15+r]);filter.P[r*15+c]=value;filter.P[c*15+r]=value;}
    const gainNorms=[0,1,2].map(c=>Math.sqrt(K.reduce((sum,value,index)=>index%3===c?sum+value*value:sum,0)));
    return {predicted,innovation,gainNorms};
  }
  function identityMatrix(n){const out=new Float64Array(n*n);for(let i=0;i<n;i++)out[i*n+i]=1;return out;}
  function matTranspose(a,rows,cols){const out=new Float64Array(a.length);for(let r=0;r<rows;r++)for(let c=0;c<cols;c++)out[c*rows+r]=a[r*cols+c];return out;}
  function matMul(a,b,rows,inner,cols){const out=new Float64Array(rows*cols);for(let r=0;r<rows;r++)for(let k=0;k<inner;k++){const av=a[r*inner+k];for(let c=0;c<cols;c++)out[r*cols+c]+=av*b[k*cols+c];}return out;}
  function skew(v){return new Float64Array([0,-v[2],v[1],v[2],0,-v[0],-v[1],v[0],0]);}
  function invert3(m){const a=m[0],b=m[1],c=m[2],d=m[3],e=m[4],f=m[5],g=m[6],h=m[7],i=m[8],det=a*(e*i-f*h)-b*(d*i-f*g)+c*(d*h-e*g),s=1/Math.max(1e-12,Math.abs(det))*Math.sign(det||1);return new Float64Array([(e*i-f*h)*s,(c*h-b*i)*s,(b*f-c*e)*s,(f*g-d*i)*s,(a*i-c*g)*s,(c*d-a*f)*s,(d*h-e*g)*s,(b*g-a*h)*s,(a*e-b*d)*s]);}
  function quatMultiply(a,b){return [a[0]*b[0]-a[1]*b[1]-a[2]*b[2]-a[3]*b[3],a[0]*b[1]+a[1]*b[0]+a[2]*b[3]-a[3]*b[2],a[0]*b[2]-a[1]*b[3]+a[2]*b[0]+a[3]*b[1],a[0]*b[3]+a[1]*b[2]-a[2]*b[1]+a[3]*b[0]];}
  function quatNormalize(q){const n=Math.hypot(...q)||1;return q.map(v=>v/n);}
  function quatExp(v){const angle=Math.hypot(...v);if(angle<1e-9)return [1,v[0]/2,v[1]/2,v[2]/2];const s=Math.sin(angle/2)/angle;return [Math.cos(angle/2),v[0]*s,v[1]*s,v[2]*s];}
  function quatFromEuler(roll,pitch,yaw){const cr=Math.cos(roll/2),sr=Math.sin(roll/2),cp=Math.cos(pitch/2),sp=Math.sin(pitch/2),cy=Math.cos(yaw/2),sy=Math.sin(yaw/2);return [cr*cp*cy+sr*sp*sy,sr*cp*cy-cr*sp*sy,cr*sp*cy+sr*cp*sy,cr*cp*sy-sr*sp*cy];}
  function quatMatrix(q){const [w,x,y,z]=q;return new Float64Array([1-2*(y*y+z*z),2*(x*y-z*w),2*(x*z+y*w),2*(x*y+z*w),1-2*(x*x+z*z),2*(y*z-x*w),2*(x*z-y*w),2*(y*z+x*w),1-2*(x*x+y*y)]);}
  function rotate(q,v){const R=quatMatrix(q);return [R[0]*v[0]+R[1]*v[1]+R[2]*v[2],R[3]*v[0]+R[4]*v[1]+R[5]*v[2],R[6]*v[0]+R[7]*v[1]+R[8]*v[2]];}
  function rotateInv(q,v){const R=quatMatrix(q);return [R[0]*v[0]+R[3]*v[1]+R[6]*v[2],R[1]*v[0]+R[4]*v[1]+R[7]*v[2],R[2]*v[0]+R[5]*v[1]+R[8]*v[2]];}
  function drawXyChart(){
    const rect=xyCanvas.getBoundingClientRect(),dpr=Math.min(devicePixelRatio||1,2),width=Math.max(1,Math.round(rect.width*dpr)),height=Math.max(1,Math.round(rect.height*dpr));
    if(xyCanvas.width!==width||xyCanvas.height!==height){xyCanvas.width=width;xyCanvas.height=height;}
    xyCtx.setTransform(dpr,0,0,dpr,0,0);
    const w=rect.width,h=rect.height,pad=24;
    xyCtx.clearRect(0,0,w,h);
    const projection=imu.posePlane==='xy'?[0,1]:imu.posePlane==='xz'?[0,2]:[1,2],axisLabels=imu.posePlane.split('');
    const scale=(h-pad*2)/(imu.xyView.rangeY*2),cx=w/2-imu.xyView.centerX*scale,cy=h/2+imu.xyView.centerY*scale;
    xyCtx.strokeStyle=css('--border');xyCtx.lineWidth=1;xyCtx.setLineDash([3,5]);
    const rawStep=imu.xyView.rangeY/4,power=Math.pow(10,Math.floor(Math.log10(rawStep))),normalized=rawStep/power,step=(normalized<2?1:normalized<5?2:5)*power;
    const minX=imu.xyView.centerX-w/(2*scale),maxX=imu.xyView.centerX+w/(2*scale),minY=imu.xyView.centerY-h/(2*scale),maxY=imu.xyView.centerY+h/(2*scale);
    for(let x=Math.ceil(minX/step)*step;x<=maxX;x+=step){const sx=cx+x*scale;xyCtx.beginPath();xyCtx.moveTo(sx,0);xyCtx.lineTo(sx,h);xyCtx.stroke();}
    for(let y=Math.ceil(minY/step)*step;y<=maxY;y+=step){const sy=cy-y*scale;xyCtx.beginPath();xyCtx.moveTo(0,sy);xyCtx.lineTo(w,sy);xyCtx.stroke();}
    xyCtx.setLineDash([]);xyCtx.strokeStyle=css('--text-muted');xyCtx.lineWidth=1.4;xyCtx.beginPath();xyCtx.moveTo(cx,0);xyCtx.lineTo(cx,h);xyCtx.moveTo(0,cy);xyCtx.lineTo(w,cy);xyCtx.stroke();
    xyCtx.fillStyle=css('--text-muted');xyCtx.font='500 9px Montserrat';if(cy>10&&cy<h-4)xyCtx.fillText(axisLabels[0]+' →',w-30,cy-6);if(cx>4&&cx<w-18)xyCtx.fillText(axisLabels[1]+' ↑',cx+6,13);xyCtx.fillText('grid '+step.toFixed(step<.1?2:1)+' m',10,15);
    const palette={truth:'#8b949e',kin:'#54a7ff',imu:'#f08b54',ekf:'#55c79a'},colors={};
    Object.keys(palette).forEach(key=>{if(imu.visibleTraces[key])colors[key]=palette[key];});
    Object.keys(colors).forEach(key=>{xyCtx.beginPath();xyCtx.strokeStyle=colors[key];xyCtx.lineWidth=key==='ekf'?2.5:1.7;imu.xyHistory.forEach((sample,i)=>{const point=sample[key],x=cx+point[projection[0]]*scale,y=cy-point[projection[1]]*scale;if(i===0)xyCtx.moveTo(x,y);else xyCtx.lineTo(x,y);});xyCtx.stroke();});
    const last=imu.xyHistory[imu.xyHistory.length-1];if(last)Object.keys(colors).forEach(key=>{const point=last[key];xyCtx.beginPath();xyCtx.fillStyle=colors[key];xyCtx.arc(cx+point[projection[0]]*scale,cy-point[projection[1]]*scale,key==='ekf'?4:3,0,Math.PI*2);xyCtx.fill();});
  }
  function setCommand(v) { state.command=Math.max(-1.2,Math.min(1.2,v)); $('[data-speed]').value=state.command; $('[data-speed-output]').textContent=state.command.toFixed(2)+' m/s'; }
  function togglePause() {
    // Freeze in place: keep the current command/velocity/pose untouched so nothing resets to a standing pose.
    state.paused=!state.paused;
    if(state.paused)$('[data-status]').textContent='Paused';
  }
  root.querySelectorAll('[data-drive]').forEach(b=>b.addEventListener('click',()=>setCommand(Number(b.dataset.drive)*.1)));
  root.querySelectorAll('[data-turn]').forEach(b=>{
    const start=()=>{state.turnCommand=Number(b.dataset.turn)*.7;};
    const stop=()=>{state.turnCommand=0;};
    b.addEventListener('pointerdown',start);
    b.addEventListener('pointerup',stop);
    b.addEventListener('pointercancel',stop);
    b.addEventListener('pointerleave',stop);
  });
  $('[data-speed]').addEventListener('input',e=>setCommand(Number(e.target.value)));
  window.addEventListener('keydown',e=>{
    if(/input/i.test(e.target.tagName))return;
    if(e.key==='ArrowLeft'){e.preventDefault();state.turnCommand=.7;}
    if(e.key==='ArrowRight'){e.preventDefault();state.turnCommand=-.7;}
    if(e.key==='ArrowUp'){e.preventDefault();setCommand(state.command+.1);}
    if(e.key==='ArrowDown'){e.preventDefault();setCommand(state.command-.1);}
    if(e.key.toLowerCase()==='a')setCommand(state.command-.1);
    if(e.key.toLowerCase()==='d')setCommand(state.command+.1);
    if(e.code==='Space'){e.preventDefault();togglePause();}
    if(e.key.toLowerCase()==='r'){setCommand(0);state.velocity=0;state.turnCommand=0;state.yawRate=0;state.worldX=0;state.worldZ=0;state.heading=0;state.phase=0;state.estimate=0;imu.prevVelocity=0;imu.prevRoll=0;imu.prevPitch=0;imu.prevYaw=0;imu.prevTruthZ=0;imu.prevTruthVz=0;imu.imuVelocity=0;imu.correctedVelocity=0;imu.time=0;imu.history=[];imu.imuYaw=0;imu.imuQ=[1,0,0,0];imu.imuVx=0;imu.imuVy=0;imu.imuVz=0;imu.imuX=0;imu.imuY=0;imu.imuZ=0;imu.kinX=0;imu.kinY=0;imu.kinZ=0;imu.eskf=freshEskf();imu.contactUpdateTimer=0;imu.lastInnovation=0;imu.xyHistory=[];resetXyView();}
  });
  window.addEventListener('keyup',e=>{if(e.key==='ArrowLeft'||e.key==='ArrowRight')state.turnCommand=0;});
  new ResizeObserver(sizeCanvas).observe(canvas); sizeCanvas(); requestAnimationFrame(tick);
})();
