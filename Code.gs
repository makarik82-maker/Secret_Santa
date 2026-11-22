/* ============================================================
   ТАЙНЫЙ САНТА 2026 — сервер v10 (Google Apps Script)
   Лист: Дата и время | Имя и Фамилия | Отдел | Контакт | Любит |
         Не дарить | Аллергии | Код | Кому дарит | Кому дарит (код)
   Секреты — в PropertiesService (никогда не попадают в публичный код).
   Публичные действия: ping, save, recover, track (по PUBLIC_TOKEN).
   Админ-действия: login/logout/list/add/update/del/draw/reset/notify/reformat
   (по сессионному токену, который выдаётся после ввода пароля).
   Установка: Расширения → Apps Script → вставить код → вписать пароль
   в setup() → выполнить setup() один раз → Развернуть → Веб-приложение
   «Выполнять как: Я», «Доступ: Все» → URL /exec и PUBLIC_TOKEN из лога
   вставить в CONFIG файла index.html.
   ============================================================ */
var HEAD=['Дата и время','Имя и Фамилия','Отдел','Контакт','Любит','Не дарить','Аллергии','Код','Кому дарит','Кому дарит (код)'];
var ALPHABET='ABCDEFGHJKMNPQRSTUVWXYZ23456789'; /* без I,L,O,0,1 — не путаются */
var CODE_LEN=6, TZ='Europe/Moscow', VER='10.0';
var LIMITS={name:80,dept:60,contact:120,likes:500,dont:300,allergies:300};
var MAIL_RE=/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
var SESS_TTL=21600; /* 6 часов */

/* ---------- настройка (выполнить один раз из редактора) ---------- */
function setup(){
  var ADMIN_PASSWORD='СМЕНИТЕ-МЕНЯ-на-длинный-пароль'; /* <-- впишите свой пароль и запустите setup() */
  var p=PropertiesService.getScriptProperties();
  var salt=Utilities.getUuid();
  p.setProperty('ADMIN_SALT',salt);
  p.setProperty('ADMIN_HASH',sha256_(salt+ADMIN_PASSWORD));
  var pub=p.getProperty('PUBLIC_TOKEN');
  if(!pub){pub='PUB-'+Utilities.getUuid().substring(0,8).toUpperCase();p.setProperty('PUBLIC_TOKEN',pub);}
  if(!p.getProperty('REG_DEADLINE'))p.setProperty('REG_DEADLINE','2026-12-01T23:59:59+03:00');
  if(!p.getProperty('SITE_URL'))p.setProperty('SITE_URL','https://makarik82-maker.github.io/Secret_Santa/');
  if(!p.getProperty('SHEET'))p.setProperty('SHEET','Участники');
  sheet_(); /* создаст лист и заголовки */
  Logger.log('Готово. PUBLIC_TOKEN для index.html: '+pub);
  Logger.log('Пароль организатора задан (хранится только хэш). Логин — в admin.html.');
  return 'OK';
}

/* ---------- транспорт ---------- */
function doGet(e){return handle_(e&&e.parameter&&e.parameter.p);}
function doPost(e){return handle_(e&&e.postData&&e.postData.contents);}
function handle_(raw){
  var out;
  try{out=run_(JSON.parse(raw||'{}'));}
  catch(err){out={ok:false,error:String(err&&err.message||err)};}
  return ContentService.createTextOutput(JSON.stringify(out)).setMimeType(ContentService.MimeType.JSON);
}

/* ---------- маршрутизация ---------- */
function run_(q){
  var a=q.action;
  if(a==='ping')return actPing_();
  if(a==='save'){pubOk_(q);return actSave_(q,false);}
  if(a==='recover'){pubOk_(q);return actRecover_(q);}
  if(a==='track'){pubOk_(q);return actTrack_(q);}
  if(a==='login')return actLogin_(q);
  /* дальше — только с действующей сессией организатора */
  needSess_(q);
  if(a==='logout'){CacheService.getScriptCache().remove('ss_'+q.token);return{ok:true};}
  if(a==='list')return actList_();
  if(a==='add')return actSave_(q,true);
  if(a==='update')return actUpdate_(q);
  if(a==='del')return actDel_(q);
  if(a==='draw')return actDraw_();
  if(a==='reset')return actReset_();
  if(a==='notify')return actNotify_(q);
  if(a==='reformat')return actReformat_();
  throw new Error('Неизвестное действие: '+a);
}

/* ---------- публичные действия ---------- */
function actPing_(){
  var rows=readAll_(),drawn=false,i;
  for(i=0;i<rows.length;i++)if(rows[i].giftCode){drawn=true;break;}
  return{ok:true,ver:VER,count:rows.length,drawDone:drawn,regOpen:regOpen_(),deadline:prop_('REG_DEADLINE',''),fmt:fmtOk_()?'new':'old'};
}
function actSave_(q,isAdmin){
  if(!isAdmin){
    if(q.hp)throw new Error('Заявка отклонена антиспам-фильтром');
    if(!throttle_('sv',30,60))throw new Error('Слишком много заявок с сайта. Подождите минуту.');
    if(!regOpen_())throw new Error('Приём заявок закрыт 1 декабря. Напишите организатору.');
  }
  var p=cleanFields_(q.p||{});
  return withLock_(function(){
    var sh=sheet_(),rows=readAll_(),i;
    for(i=0;i<rows.length;i++)if(rows[i].contact.toLowerCase()===p.contact.toLowerCase())
      throw new Error('Эта почта уже зарегистрирована. Нажмите «Забыли код?» — код придёт письмом.');
    var code=genCode_(rows),r=sh.getLastRow()+1;
    putRow_(sh,r,[stamp_(),p.name,p.dept,p.contact,p.likes,p.dont,p.allergies,code,'','']);
    /* если жеребьёвка уже была — вставляем новичка в цикл, меняя ровно одно назначение */
    var inserted=false;
    var prev=readAll_().filter(function(x){return x.code!==code&&x.giftCode;});
    var order=cycleOrder_(prev);
    if(order&&order.length>=2){
      var byCode=indexByCode_(readAll_());
      var k=Math.floor(Math.random()*order.length);
      var giver=byCode[order[k]],target=byCode[order[(k+1)%order.length]],fresh=byCode[code];
      writeGift_(sh,giver.r,fresh.name,fresh.code);
      writeGift_(sh,fresh.r,target.name,target.code);
      inserted=true;
      sendMail_(giver.contact,'🎄 Тайный Санта 2026 — маршрут обновлён',
        'Здравствуйте, '+giver.name+'!\n\nВ рейс добавился новый участник, поэтому ваш подопечный изменился.\nТеперь вы дарите: '+fresh.name+' ('+(fresh.dept||'отдел не указан')+').\nПожелания: '+fresh.likes+'\nНе дарить: '+(fresh.dont||'—')+'\nАллергии: '+(fresh.allergies||'—')+'\n\nБюджет — до 1000 ₽. Обмен — 25 декабря.\nЕсли подарок уже куплен — напишите организатору, он поможет.');
    }
    sendMail_(p.contact,'🎄 Тайный Санта 2026 — ваш секретный код',
      'Здравствуйте, '+p.name+'!\n\nВаш секретный код: '+code+'\nСохраните это письмо. После жеребьёвки 2 декабря введите код на сайте '+prop_('SITE_URL','')+' в разделе «Кому я дарю?» — он покажет вашего подопечного.\n\nБюджет подарка — до 1000 ₽. Обмен — 25 декабря.\nПотеряете код — на сайте есть кнопка «Забыли код?», код снова придёт письмом.');
    return{ok:true,code:code,inserted:inserted};
  });
}
function actRecover_(q){
  if(!throttle_('rc',10,60))throw new Error('Слишком много запросов. Подождите минуту.');
  var mail=clean_(q.contact,120).toLowerCase();
  var rows=readAll_(),i;
  for(i=0;i<rows.length;i++)if(rows[i].contact.toLowerCase()===mail){
    sendMail_(rows[i].contact,'🎄 Тайный Санта 2026 — напоминание кода',
      'Здравствуйте, '+rows[i].name+'!\n\nВаш секретный код: '+rows[i].code+'\nВведите его на сайте '+prop_('SITE_URL','')+' в разделе «Кому я дарю?».');
    break;
  }
  Utilities.sleep(300); /* одинаковое время ответа — нельзя перебором узнать, кто зарегистрирован */
  return{ok:true,msg:'Если такая почта есть в базе, код придёт письмом в течение минуты.'};
}
function actTrack_(q){
  if(!throttle_('tk',120,60))throw new Error('Слишком много запросов. Подождите минуту.');
  var code=normCode_(q.code);
  if(!throttle_('tk_'+code,30,60))throw new Error('Слишком много попыток по этому коду. Подождите минуту.');
  var rows=readAll_(),row=findByCode_(rows,code),i,drawn=false;
  if(!row){Utilities.sleep(250);throw new Error('Код не найден. Проверьте 6 символов (буквы и цифры).');}
  for(i=0;i<rows.length;i++)if(rows[i].giftCode){drawn=true;break;}
  if(!drawn)return{ok:true,status:'pending'};
  if(!row.giftCode)return{ok:true,status:'late'};
  var to=findByCode_(rows,row.giftCode);
  if(!to)return{ok:true,status:'late'};
  /* БЕЛЫЙ СПИСОК ПОЛЕЙ: никаких кодов, почт и обратных связей */
  return{ok:true,status:'ok',to:{name:to.name,dept:to.dept,likes:to.likes,dont:to.dont,allergies:to.allergies}};
}

/* ---------- авторизация организатора ---------- */
function actLogin_(q){
  var cache=CacheService.getScriptCache();
  var fails=Number(cache.get('lg_f')||0);
  if(fails>=10)throw new Error('Слишком много попыток входа. Подождите 15 минут.');
  Utilities.sleep(400);
  var p=PropertiesService.getScriptProperties();
  var salt=p.getProperty('ADMIN_SALT'),hash=p.getProperty('ADMIN_HASH');
  if(!salt||!hash)throw new Error('Сервер не настроен: выполните setup() в Apps Script.');
  if(sha256_(salt+String(q.pass||''))!==hash){
    cache.put('lg_f',String(fails+1),900);
    throw new Error('Неверный пароль');
  }
  cache.remove('lg_f');
  var token=Utilities.getUuid();
  cache.put('ss_'+token,'1',SESS_TTL);
  return{ok:true,token:token,ttl:SESS_TTL};
}
function needSess_(q){
  var cache=CacheService.getScriptCache(),k='ss_'+String(q.token||'');
  if(!q.token||cache.get(k)!=='1')throw new Error('Сессия недействительна или истекла — войдите снова.');
  cache.put(k,'1',SESS_TTL); /* продлеваем сессию при активности */
}
function pubOk_(q){
  var pub=PropertiesService.getScriptProperties().getProperty('PUBLIC_TOKEN');
  if(!pub)throw new Error('Сервер не настроен: выполните setup() в Apps Script.');
  if(String(q.t||'')!==pub)throw new Error('Неверный публичный токен сайта.');
}

/* ---------- админ-действия ---------- */
function actList_(){
  var rows=readAll_();
  var drawn=rows.filter(function(r){return r.giftCode;});
  return{ok:true,rows:rows.map(function(r){
    return{date:r.date,name:r.name,dept:r.dept,contact:r.contact,likes:r.likes,dont:r.dont,allergies:r.allergies,code:r.code,giftName:r.giftName,giftCode:r.giftCode};
  }),drawTs:prop_('DRAW_TS',''),drawValid:drawn.length?!!cycleOrder_(drawn):false,fmt:fmtOk_()?'new':'old'};
}
function actUpdate_(q){
  var p=cleanFields_(q.p||{});
  return withLock_(function(){
    var sh=sheet_(),rows=readAll_(),row=findByCode_(rows,normCode_(q.code)),i;
    if(!row)throw new Error('Участник не найден');
    for(i=0;i<rows.length;i++)if(rows[i].code!==row.code&&rows[i].contact.toLowerCase()===p.contact.toLowerCase())
      throw new Error('Такая почта уже есть у другого участника');
    sh.getRange(row.r,2,1,6).setNumberFormat('@').setValues([[p.name,p.dept,p.contact,p.likes,p.dont,p.allergies]]);
    if(p.name!==row.name)for(i=0;i<rows.length;i++)if(rows[i].giftCode===row.code)
      sh.getRange(rows[i].r,9).setNumberFormat('@').setValue(p.name);
    return{ok:true};
  });
}
function actDel_(q){
  var codes=(q.codes||[]).map(normCode_);
  if(!codes.length)throw new Error('Не указаны коды');
  return withLock_(function(){
    var sh=sheet_(),all=readAll_(),i;
    var drawn=all.filter(function(x){return x.giftCode;});
    var order=cycleOrder_(drawn);
    var keep=all.filter(function(x){return codes.indexOf(x.code)<0;});
    var removed=all.length-keep.length;
    /* чиним цикл: меняются только назначения, соседние с удалёнными */
    var repaired=false,reset=false;
    if(!order){
      if(drawn.length){
        for(i=0;i<keep.length;i++)writeGift_(sh,keep[i].r,'','');
        PropertiesService.getScriptProperties().deleteProperty('DRAW_TS');
        reset=true;
      }
    }else{
      var newOrder=order.filter(function(c){return codes.indexOf(c)<0;});
      if(newOrder.length>=2){
        var byCode=indexByCode_(keep);
        for(i=0;i<newOrder.length;i++){
          var g=byCode[newOrder[i]],t=byCode[newOrder[(i+1)%newOrder.length]];
          writeGift_(sh,g.r,t.name,t.code);
        }
        repaired=true;
      }else{
        for(i=0;i<keep.length;i++)writeGift_(sh,keep[i].r,'','');
        PropertiesService.getScriptProperties().deleteProperty('DRAW_TS');
        reset=true;
      }
    }
    var rs=all.filter(function(x){return codes.indexOf(x.code)>-1;}).map(function(x){return x.r;}).sort(function(a,b){return b-a;});
    for(i=0;i<rs.length;i++)sh.deleteRow(rs[i]);
    return{ok:true,removed:removed,repaired:repaired,drawReset:reset};
  });
}
function actDraw_(){
  return withLock_(function(){
    var sh=sheet_(),rows=readAll_(),n=rows.length,i;
    if(n<2)throw new Error('Нужно минимум 2 участника');
    var a=sattolo_(n),targets={},self=0;
    for(i=0;i<n;i++){
      var t=rows[a[i]];
      writeGift_(sh,rows[i].r,t.name,t.code);
      targets[t.code]=(targets[t.code]||0)+1;
      if(t.code===rows[i].code)self++;
    }
    var uniq=0,k;for(k in targets)if(targets.hasOwnProperty(k))uniq++;
    if(uniq!==n||self!==0)throw new Error('Внутренняя проверка не пройдена — жеребьёвка отменена');
    var at=new Date().toISOString();
    PropertiesService.getScriptProperties().setProperty('DRAW_TS',at);
    return{ok:true,n:n,verified:true,at:at};
  });
}
function actReset_(){
  return withLock_(function(){
    var sh=sheet_(),rows=readAll_(),i;
    for(i=0;i<rows.length;i++)if(rows[i].giftCode||rows[i].giftName)writeGift_(sh,rows[i].r,'','');
    PropertiesService.getScriptProperties().deleteProperty('DRAW_TS');
    return{ok:true};
  });
}
function actNotify_(q){
  var kind=q.kind,rows=readAll_(),sent=0,fail=0,i;
  if(kind!=='codes'&&kind!=='targets')throw new Error('kind должен быть codes или targets');
  var byCode=indexByCode_(rows);
  for(i=0;i<rows.length;i++){
    var r=rows[i],okMail=false;
    if(kind==='codes'){
      okMail=sendMail_(r.contact,'🎄 Тайный Санта 2026 — ваш секретный код',
        'Здравствуйте, '+r.name+'!\n\nВаш секретный код: '+r.code+'\nСайт: '+prop_('SITE_URL','')+' → «Кому я дарю?».\nБюджет — до 1000 ₽, обмен — 25 декабря.');
    }else{
      var t=byCode[r.giftCode];
      if(!t)continue;
      okMail=sendMail_(r.contact,'🎁 Тайный Санта 2026 — ваш подопечный',
        'Здравствуйте, '+r.name+'!\n\nЖеребьёвка прошла! Вы дарите: '+t.name+' ('+(t.dept||'отдел не указан')+').\nПожелания: '+t.likes+'\nНе дарить: '+(t.dont||'—')+'\nАллергии: '+(t.allergies||'—')+'\n\nБюджет — до 1000 ₽. Подготовьте подарок до 24 декабря, обмен — 25 декабря.\nИмя вашего Санты остаётся секретом 😉');
    }
    if(okMail)sent++;else fail++;
  }
  return{ok:true,sent:sent,fail:fail};
}
function actReformat_(){
  return withLock_(function(){
    var sh=sheet_(),v=sh.getDataRange().getValues();
    var aliases={'Дата и время':0,'created':0,'Имя и Фамилия':1,'Имя':1,'name':1,'Отдел':2,'dept':2,'Контакт':3,'email':3,'E-mail':3,'Любит':4,'likes':4,'Не дарить':5,'dont':5,'Аллергии':6,'allergies':6,'Код':7,'code':7,'Кому дарит':8,'Кому дарит (код)':9};
    var map=null,i,j;
    if(v.length&&(String(v[0][7])==='Код'||String(v[0][0])==='Дата и время')){
      map=[];for(j=0;j<v[0].length;j++){var h=String(v[0][j]);map.push(aliases.hasOwnProperty(h)?aliases[h]:-1);}
    }
    var out=[HEAD],body=map?v.slice(1):v;
    for(i=0;i<body.length;i++){
      var row=['','','','','','','','','',''];
      if(!body[i].join(''))continue;
      for(j=0;j<body[i].length;j++){var idx=map?map[j]:j;if(idx>=0&&idx<10)row[idx]=guard_(body[i][j],LIMITS[HEAD[idx]]||500);}
      if(!row[7])continue;
      out.push(row);
    }
    sh.clearContents();
    ensureRows_(sh,out.length);
    sh.getRange(1,1,out.length,10).setNumberFormat('@').setValues(out);
    return{ok:true,rows:out.length-1};
  });
}

/* ---------- лист и данные ---------- */
function sheet_(){
  var ss=SpreadsheetApp.getActiveSpreadsheet();
  var name=prop_('SHEET','Участники');
  var sh=ss.getSheetByName(name);
  if(!sh)sh=ss.insertSheet(name);
  if(sh.getLastRow()===0)sh.getRange(1,1,1,10).setNumberFormat('@').setValues([HEAD]);
  return sh;
}
function fmtOk_(){
  var v=sheet_().getRange(1,1,1,10).getValues()[0];
  return String(v[9])===HEAD[9];
}
function readAll_(){
  var sh=sheet_(),v=sh.getDataRange().getValues(),out=[],i;
  for(i=1;i<v.length;i++){
    var r=v[i],code=String(r[7]==null?'':r[7]).trim();
    if(!code)continue;
    out.push({r:i+1,date:String(r[0]||''),name:String(r[1]||''),dept:String(r[2]||''),contact:String(r[3]||''),
      likes:String(r[4]||''),dont:String(r[5]||''),allergies:String(r[6]||''),code:code,
      giftName:String(r[8]||''),giftCode:String(r[9]==null?'':r[9]).trim()});
  }
  return out;
}
function ensureRows_(sh,n){if(n>sh.getMaxRows())sh.insertRowsAfter(sh.getMaxRows(),n-sh.getMaxRows());}
function putRow_(sh,r,vals){ensureRows_(sh,r);sh.getRange(r,1,1,10).setNumberFormat('@').setValues([vals]);}
function writeGift_(sh,r,name,code){sh.getRange(r,9,1,2).setNumberFormat('@').setValues([[name,code]]);}
function findByCode_(rows,code){for(var i=0;i<rows.length;i++)if(rows[i].code===code)return rows[i];return null;}
function indexByCode_(rows){var m={},i;for(i=0;i<rows.length;i++)m[rows[i].code]=rows[i];return m;}
/* порядок участников в цикле дарения; null, если цикл неполный/сломан */
function cycleOrder_(rows){
  var n=rows.length;if(n<2)return null;
  var m={},i;for(i=0;i<n;i++){if(!rows[i].giftCode)return null;m[rows[i].code]=rows[i].giftCode;}
  var order=[rows[0].code],seen={};seen[rows[0].code]=1;
  for(i=1;i<n;i++){
    var next=m[order[i-1]];
    if(!next||seen[next])return null;
    order.push(next);seen[next]=1;
  }
  if(m[order[n-1]]!==order[0])return null;
  return order;
}
/* алгоритм Саттоло: один цикл, никто не дарит сам себе */
function sattolo_(n){
  var a=[],i,j,t;
  for(i=0;i<n;i++)a.push(i);
  for(i=n-1;i>0;i--){j=Math.floor(Math.random()*i);t=a[i];a[i]=a[j];a[j]=t;}
  return a;
}
function genCode_(rows){
  var used={},i,k,c;
  for(i=0;i<rows.length;i++)used[rows[i].code]=1;
  for(k=0;k<200;k++){
    c='';for(i=0;i<CODE_LEN;i++)c+=ALPHABET.charAt(Math.floor(Math.random()*ALPHABET.length));
    if(!used[c])return c;
  }
  throw new Error('Не удалось сгенерировать уникальный код');
}

/* ---------- утилиты ---------- */
function prop_(k,def){var v=PropertiesService.getScriptProperties().getProperty(k);return v==null?def:v;}
function regOpen_(){var d=prop_('REG_DEADLINE','');return !d||Date.now()<=new Date(d).getTime();}
function stamp_(){return Utilities.formatDate(new Date(),TZ,'dd.MM.yyyy HH.mm.ss');}
function normCode_(c){return String(c==null?'':c).toUpperCase().replace(/[^A-Z0-9]/g,'');}
function clean_(s,max){return String(s==null?'':s).replace(/[\u0000-\u001F\u007F]/g,' ').replace(/\s+/g,' ').trim().substring(0,max);}
function guard_(s,max){return clean_(s,max);} /* защита от формул — текстовый формат '@' всех ячеек */
function cleanFields_(p){
  var o={name:clean_(p.name,LIMITS.name),dept:clean_(p.dept,LIMITS.dept),contact:clean_(p.contact,LIMITS.contact),
    likes:clean_(p.likes,LIMITS.likes),dont:clean_(p.dont,LIMITS.dont),allergies:clean_(p.allergies,LIMITS.allergies)};
  if(o.name.length<3)throw new Error('Укажите имя и фамилию (минимум 3 символа)');
  if(!MAIL_RE.test(o.contact))throw new Error('Формат почты: name@company.ru');
  if(o.likes.length<3)throw new Error('Добавьте пожелания — пара слов поможет вашему Санте');
  return o;
}
function sha256_(s){
  var b=Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256,s),h='',i,x;
  for(i=0;i<b.length;i++){x=(b[i]&255).toString(16);h+=x.length<2?'0'+x:x;}
  return h;
}
function throttle_(key,max,ttl){
  var c=CacheService.getScriptCache(),k='th_'+key,n=Number(c.get(k)||0);
  if(n>=max)return false;
  c.put(k,String(n+1),ttl);
  return true;
}
function withLock_(fn){
  var lock=LockService.getScriptLock();
  if(!lock.tryLock(30000))throw new Error('Таблица занята другой операцией — повторите через пару секунд');
  try{return fn();}finally{lock.releaseLock();}
}
function sendMail_(to,subj,body){
  try{MailApp.sendEmail({to:to,subject:subj,body:body});return true;}
  catch(e){Logger.log('Почта не отправлена ('+to+'): '+e);return false;}
}
