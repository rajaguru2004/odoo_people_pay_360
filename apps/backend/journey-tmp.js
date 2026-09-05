/**
 * Live journey: drive the real inbound pipeline for the READ-ONLY actions and
 * assert each one resolves and completes. Writes are excluded on purpose —
 * this must not punch anybody in or file a claim.
 */
const fs=require('fs');
const {PrismaClient}=require('@prisma/client');
const env={};
for(const l of fs.readFileSync('/home/suryaguru/StudioProjects/CRM/human-resource-management/apps/backend/.env','utf8').split('\n')){
  const m=/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/.exec(l);
  if(m){let v=m[2].trim();if(/^["'].*["']$/.test(v))v=v.slice(1,-1);env[m[1]]=v;}
}
const PHONE='917708315210';
const BASE='http://localhost:3011';

const READS=[
  ["Today's attendance",'attendance.today'],
  ['My schedule','calendar.my'],
  ['Leave balance','leave.balance'],
  ['My leave requests','leave.my'],
  ['My overtime','overtime.my'],
  ['My travel requests','travel.my'],
  ['My training','training.my'],
  ['My company items','asset.my'],
  ['Holidays','holiday.list'],
  ['This month','attendance.history'],
];

(async()=>{
  const prisma=new PrismaClient();
  const hook=await (await fetch(env.WHATSAPP_BASE_URL.replace(/\/$/,'')+'/webhook/find/'+env.WHATSAPP_INSTANCE_NAME,
    {headers:{apikey:env.WHATSAPP_API_KEY}})).json();
  const token=hook.headers['x-hrms-webhook-token'];

  let pass=0, fail=0;
  for(const [text,expected] of READS){
    const id='JR2'+Date.now()+Math.floor(Math.random()*1000);
    await fetch(BASE+'/whatsapp/webhook',{method:'POST',
      headers:{'Content-Type':'application/json','x-hrms-webhook-token':token},
      body:JSON.stringify({event:'messages.upsert',instance:env.WHATSAPP_INSTANCE_NAME,data:{
        key:{remoteJid:PHONE+'@s.whatsapp.net',fromMe:false,id,senderPn:PHONE+'@s.whatsapp.net'},
        pushName:'Raja Guru',messageType:'conversation',message:{conversation:text}}})});
    await new Promise(r=>setTimeout(r,2600));
    const row=await prisma.whatsAppInboundMessage.findFirst({where:{waMessageId:id}});
    const ok = row && row.status==='DONE' && row.resolvedActionKey===expected && !row.lastError;
    console.log((ok?'PASS':'FAIL').padEnd(5), text.padEnd(22),
      'status='+(row?.status??'-'), 'action='+(row?.resolvedActionKey??'-'),
      row?.lastError?('ERR='+row.lastError.slice(0,60)):'');
    ok?pass++:fail++;
  }
  console.log(`\n${pass} passed, ${fail} failed`);
  await prisma.$disconnect();
})();
