import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

const app = document.querySelector('[data-kinematics-app]');
const host = app && app.querySelector('[data-go2-world]');
if (app && host) {
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(34, 1, 0.01, 30);
  camera.position.set(1.22, 0.82, 1.18);

  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.15;
  host.prepend(renderer.domElement);

  const controls = new OrbitControls(camera, renderer.domElement);
  controls.target.set(0, 0.2, 0);
  controls.enableDamping = true;
  controls.dampingFactor = 0.07;
  controls.minDistance = 0.72;
  controls.maxDistance = 2.8;
  controls.maxPolarAngle = Math.PI * 0.48;

  scene.add(new THREE.HemisphereLight(0xffffff, 0x26303a, 2.25));
  const key = new THREE.DirectionalLight(0xffffff, 3.2);
  key.position.set(-1.4, 2.7, 2.2);
  key.castShadow = true;
  key.shadow.mapSize.set(1024, 1024);
  key.shadow.camera.near = 0.1;
  key.shadow.camera.far = 8;
  scene.add(key);
  const rim = new THREE.DirectionalLight(0xf0c640, 1.8);
  rim.position.set(2, 1, -2);
  scene.add(rim);

  const floorMat = new THREE.MeshStandardMaterial({ color: 0x242a31, roughness: 0.9, metalness: 0.05 });
  const floor = new THREE.Mesh(new THREE.PlaneGeometry(30, 30), floorMat);
  floor.rotation.x = -Math.PI / 2;
  floor.receiveShadow = true;
  scene.add(floor);
  const grid = new THREE.GridHelper(30, 120, 0x687480, 0x3e4852);
  grid.position.y = 0.002;
  grid.material.opacity = 0.32;
  grid.material.transparent = true;
  scene.add(grid);

  const actor = new THREE.Group();
  scene.add(actor);
  const robot = new THREE.Group();
  robot.rotation.x = -Math.PI / 2;
  actor.add(robot);
  const trailPoints=[new THREE.Vector3(0,.007,0)];
  const trailGeometry=new THREE.BufferGeometry().setFromPoints(trailPoints);
  const trail=new THREE.Line(trailGeometry,new THREE.LineBasicMaterial({color:0xf0c640,transparent:true,opacity:.5}));
  scene.add(trail);
  let lastTrailPoint=trailPoints[0].clone();
  const followTarget=new THREE.Vector3();
  const followDelta=new THREE.Vector3();
  const loader = new GLTFLoader();
  const basePath = new URL('../models/go2/', import.meta.url);
  const load = (name) => new Promise((resolve, reject) => loader.load(new URL(name + '.glb', basePath).href, g => resolve(g.scene), undefined, reject));
  const legJoints = [];
  let motion = null;
  let motionFrame = 0;
  let motionBlend = 0, gaitBlend = 0;   // gaitBlend ramps in and HOLDS, so a stop freezes the pose
  let lastTick = performance.now();
  let supportY = 0.40;   // last on-legs body height (held during a flight phase, then a hop is added)
  let lastTrailEpoch = 0;   // bumped by trajectory.js to clear the yellow trail on a new/clear walk
  const standQ = [0, 0.82, -1.55];
  const flatContactRotation = new THREE.Quaternion().setFromEuler(new THREE.Euler(-Math.PI / 2, 0, 0));
  const parentWorldRotation = new THREE.Quaternion();
  const contactWorldPosition = new THREE.Vector3();

  // Sparse landmarks make translation and turning legible while the camera follows.
  const landmarkMaterial=new THREE.MeshStandardMaterial({color:0x65717c,roughness:.8,metalness:.08});
  [[2.2,-1.4],[-1.8,-2.2],[3.4,2.1],[-3.2,1.5],[.8,3.3]].forEach(([x,z],i)=>{
    const marker=new THREE.Mesh(new THREE.CylinderGeometry(.025,.055,.18,8),landmarkMaterial);
    marker.position.set(x,.09,z); marker.castShadow=true; scene.add(marker);
    const cap=new THREE.Mesh(new THREE.SphereGeometry(.035,12,8),new THREE.MeshBasicMaterial({color:i%2?0x54a7ff:0xf0c640}));
    cap.position.set(x,.2,z); scene.add(cap);
  });

  function tuneModel(object) {
    object.traverse(child => {
      if (!child.isMesh) return;
      child.castShadow = true;
      child.receiveShadow = true;
      const materials = Array.isArray(child.material) ? child.material : [child.material];
      materials.forEach(m => { if (m) { m.roughness = 0.46; m.metalness = 0.14; m.needsUpdate = true; } });
    });
    return object;
  }
  function clonePart(source) { return tuneModel(source.clone(true)); }
  function joint() { const g = new THREE.Group(); return g; }

  const motionRequest = fetch(new URL('../data/go2-walk.json', import.meta.url)).then(r => {
    if (!r.ok) throw new Error('motion data ' + r.status);
    return r.json();
  });
  Promise.all([...['base','hip','thigh','thigh_mirror','calf','calf_mirror','foot'].map(load), motionRequest]).then(parts => {
    const [base, hipMesh, thighMesh, thighMirror, calfMesh, calfMirror, footMesh, motionData] = parts;
    motion = motionData;
    robot.add(tuneModel(base));

    const specs = [
      { name:'FL', x:.1934, y:.0465, side:1, front:1, mirror:false },
      { name:'FR', x:.1934, y:-.0465, side:-1, front:1, mirror:true },
      { name:'RL', x:-.1934, y:.0465, side:1, front:-1, mirror:false },
      { name:'RR', x:-.1934, y:-.0465, side:-1, front:-1, mirror:true }
    ];
    specs.forEach(s => {
      const abad = joint(); abad.name=s.name+'_hip_joint'; abad.position.set(s.x,s.y,0); robot.add(abad);
      abad.add(clonePart(hipMesh));
      const hip = joint(); hip.name=s.name+'_thigh_joint'; hip.position.set(0,s.side*.0955,0); abad.add(hip);
      hip.add(clonePart(s.mirror?thighMirror:thighMesh));
      const knee = joint(); knee.name=s.name+'_calf_joint'; knee.position.set(0,0,-.213); hip.add(knee);
      knee.add(clonePart(s.mirror?calfMirror:calfMesh));
      const foot = clonePart(footMesh); foot.position.set(0,0,-.213); knee.add(foot);
      const contact = new THREE.Mesh(new THREE.RingGeometry(.035,.052,32),new THREE.MeshBasicMaterial({color:0xf0c640,transparent:true,opacity:.75,side:THREE.DoubleSide}));
      // Measured from the converted GLB: calf origin → lowest sole vertex = 0.2359 m.
      contact.position.set(0,0,-.236); knee.add(contact);
      legJoints.push({ ...s, abad, hip, knee, contact });
    });
    robot.position.y=.42;
    const loading = host.querySelector('[data-model-loading]');
    if (loading) loading.classList.add('is-loaded');
  }).catch(error => {
    const loading=host.querySelector('[data-model-loading]');
    if(loading) loading.innerHTML='<i class="fas fa-triangle-exclamation"></i><span>Could not load the 3D model</span>';
    console.error('[GO2 viewer]', error && (error.stack || error.message || String(error)));
  });

  function resize() {
    const rect=host.getBoundingClientRect();
    renderer.setSize(rect.width,rect.height,false);
    camera.aspect=rect.width/Math.max(1,rect.height);
    camera.updateProjectionMatrix();
  }
  new ResizeObserver(resize).observe(host);
  resize();

  function lerpAngle(a,b,t) { return a+(b-a)*t; }
  function sampleFrame(index) {
    if (!motion || !motion.frames.length) return null;
    const count=motion.frames.length;
    const wrapped=((index%count)+count)%count;
    const i0=Math.floor(wrapped), i1=(i0+1)%count, t=wrapped-i0;
    const a=motion.frames[i0], b=motion.frames[i1];
    return {
      q:a.q.map((v,i)=>lerpAngle(v,b.q[i],t)),
      qd:a.qd.map((v,i)=>lerpAngle(v,b.qd[i],t)),
      feet:a.feet.map((v,i)=>lerpAngle(v,b.feet[i],t)),
      vb:a.vb.map((v,i)=>lerpAngle(v,b.vb[i],t)),
      base:a.base.map((v,i)=>lerpAngle(v,b.base[i],t))
    };
  }

  function animate() {
    requestAnimationFrame(animate);
    const s=app.go2State || {velocity:0,phase:0};
    const now=performance.now(), dt=Math.min(.05,(now-lastTick)/1000); lastTick=now;
    if(!s.paused){
    const speed=Math.abs(s.velocity);
    const moving=speed>.035||Math.abs(s.yawRate||0)>.04;
    motionBlend+=((moving?1:0)-motionBlend)*Math.min(1,dt*(moving?4.5:3));
    const locomotionRate=Math.max(speed,Math.abs(s.yawRate||0)*.16);
    const playbackScale=moving?(locomotionRate/.78)*Math.sign(s.velocity||1):0;
    if(moving && motion)motionFrame+=dt*motion.fps*playbackScale;
    const frame=sampleFrame(motionFrame);
    // gait drive: trajectory.js publishes per-leg stance/swing progress → procedural walk that
    // matches the selected gait (trot/pace/bound/pronk). Falls back to the mocap clip if absent.
    const gaitLeg=(app.go2State && app.go2State.legState) || null;
    // Trunk pitch is rotation about the URDF y-axis (robot's local frame is x-forward / z-up);
    // + tips the nose down over the loaded front pair. Set before the sole pin so the ground
    // contact is solved against the pitched pose.
    if(gaitLeg) gaitBlend+=(1-gaitBlend)*Math.min(1,dt*4.5);
    const poseBlend=gaitLeg?gaitBlend:motionBlend;
    if(gaitLeg){ robot.position.y=.40; robot.rotation.z=0; robot.rotation.y=((app.go2State && app.go2State.bodyPitch)||0)*poseBlend; }
    else { robot.rotation.y=0; const centerZ=.347; robot.position.y=.385+(frame?(frame.base[2]-centerZ)*motionBlend:0); robot.rotation.z=frame?frame.base[4]*motionBlend:0; }
    const hipMap=[1,0,3,2], thighMap=[5,4,7,6], calfMap=[9,8,11,10], feetMap=[0,2,1,3];
    const legQ=(app.go2State && app.go2State.legQ) || null;   // joint angles computed in trajectory.js
    const contacts=[];
    legJoints.forEach((leg,i) => {
      let q, stance;
      if(legQ && legQ[i]){
        q=legQ[i].map((v,j)=>lerpAngle(standQ[j],v,poseBlend));   // apply the published gait pose
        stance=(gaitLeg && gaitLeg[i] ? gaitLeg[i].contact : true);   // keep the frozen contact set visible
      } else {
        const raw=frame?[frame.q[hipMap[i]],frame.q[thighMap[i]],frame.q[calfMap[i]]]:standQ;
        q=raw.map((v,j)=>lerpAngle(standQ[j],v,motionBlend));
        const footZ=frame?frame.feet[feetMap[i]*3+2]:0; stance=!moving||footZ<.04;
      }
      leg.abad.rotation.x=q[0]; leg.hip.rotation.y=q[1]; leg.knee.rotation.y=q[2];
      contacts.push(stance);
      leg.contact.visible=stance;
      leg.contact.material.opacity=.45+.3*Math.sin(now*.004)**2;
      leg.currentQ=q; leg.currentQd=[0,0,0];
      leg.currentVb=(app.go2State && app.go2State.velocity)||0;
    });
    // Ground collision guard: use the lowest sole across all four feet, including swing feet.
    // This prevents a mislabeled contact or interpolated motion frame from entering the floor.
    robot.updateMatrixWorld(true);
    if(gaitLeg){
      // pin the lowest STANCE foot to the ground; during a flight phase (no stance foot) hold the
      // last support height so the already-lifted swing feet leave the ground, then add a hop.
      const stanceSoles=[];
      legJoints.forEach((leg,i)=>{ if(contacts[i]){ leg.contact.getWorldPosition(contactWorldPosition); stanceSoles.push(contactWorldPosition.y); } });
      if(stanceSoles.length){ robot.position.y += .006 - Math.min(...stanceSoles); supportY=robot.position.y; }
      else { robot.position.y = supportY; }
      robot.position.y += .12 * ((app.go2State && app.go2State.bodyLift) || 0);
      robot.updateMatrixWorld(true);
    } else {
      const soleHeights=[];
      legJoints.forEach(leg => { leg.contact.getWorldPosition(contactWorldPosition); soleHeights.push(contactWorldPosition.y); });
      if(soleHeights.length){ robot.position.y+=.006-Math.min(...soleHeights); robot.updateMatrixWorld(true); }
    }
    // Markers follow each foot position, but remain parallel to the world ground.
    legJoints.forEach(leg => {
      leg.knee.getWorldQuaternion(parentWorldRotation);
      leg.contact.quaternion.copy(parentWorldRotation.invert().multiply(flatContactRotation));
    });
    if(legJoints.length){
      let selected=contacts.findIndex(Boolean); if(selected<0)selected=0;
      app.go2Telemetry={contacts,selected,q:legJoints[selected].currentQ,qd:legJoints[selected].currentQd,legs:legJoints.map((leg,i)=>({name:leg.name,q:leg.currentQ,qd:leg.currentQd,vb:leg.currentVb,contact:contacts[i]})),frame:motionFrame,source:'Kine2Go 60 Hz'};
    }
    actor.position.set(s.worldX||0,0,s.worldZ||0);
    actor.rotation.y=s.heading||0;
    const poseLabel=app.querySelector('[data-world-pose]');
    if(poseLabel)poseLabel.textContent='X '+(s.worldX||0).toFixed(2)+' · Z '+(s.worldZ||0).toFixed(2)+' · YAW '+Math.round((s.heading||0)*180/Math.PI)+'°';
    if((s.trailEpoch||0)!==lastTrailEpoch){   // new walk / cleared → wipe the trail
      lastTrailEpoch=s.trailEpoch||0; trailPoints.length=0;
      trailPoints.push(new THREE.Vector3(actor.position.x,.007,actor.position.z));
      lastTrailPoint.copy(actor.position);
      trail.geometry.dispose(); trail.geometry=new THREE.BufferGeometry().setFromPoints(trailPoints);
    }
    if(actor.position.distanceTo(lastTrailPoint)>.07){
      trailPoints.push(new THREE.Vector3(actor.position.x,.007,actor.position.z));
      if(trailPoints.length>400)trailPoints.shift();
      trail.geometry.dispose(); trail.geometry=new THREE.BufferGeometry().setFromPoints(trailPoints);
      lastTrailPoint.copy(actor.position);
    }
    }
    followTarget.set(actor.position.x,.2,actor.position.z);
    followDelta.subVectors(followTarget,controls.target);
    camera.position.add(followDelta);
    controls.target.copy(followTarget);
    controls.update();
    renderer.render(scene,camera);
  }
  animate();
}
