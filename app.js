/* ============================================================
   HOSPITAL MUNICIPAL DE MALANJE
   Sistema de Gestão de Medicamentos v2.0
   - Credenciais armazenadas com hash SHA-256 (nunca expostas)
   - Gestão de Utilizadores
   - Sincronização Offline ↔ Google Sheets
   - Gráficos de consumo (Chart.js)
   - Pesquisa por data e tipo de movimentação
   - Exportação/Importação exclusivamente em XLSX
   ============================================================ */

'use strict';

// ===================== XLSX PURO (sem CDN, sem dependências) =====================
// Motor XLSX completo: ZIP não-comprimido + OOXML.
// Funciona 100% offline, sem SheetJS nem qualquer biblioteca externa.
const XLSXio = (() => {
  const enc = new TextEncoder();
  const dec = new TextDecoder();

  /* --- Primitivos ZIP --- */
  function u16(n){ return [n&0xff,(n>>8)&0xff]; }
  function u32(n){ return [n&0xff,(n>>8)&0xff,(n>>16)&0xff,(n>>24)&0xff]; }
  function cat(...a){ const b=new Uint8Array(a.reduce((s,x)=>s+(x.length||x.byteLength||0),0));let o=0;for(const x of a){b.set(x instanceof Uint8Array?x:new Uint8Array(x),o);o+=x.length||x.byteLength;}return b; }
  function crc32(d){
    if(!crc32._t){crc32._t=new Uint32Array(256);for(let i=0;i<256;i++){let c=i;for(let j=0;j<8;j++)c=c&1?0xEDB88320^(c>>>1):c>>>1;crc32._t[i]=c;}}
    let c=0xFFFFFFFF;for(let i=0;i<d.length;i++)c=crc32._t[(c^d[i])&0xFF]^(c>>>8);return(c^0xFFFFFFFF)>>>0;
  }

  /* --- Escrever ZIP (stored, sem compressão) --- */
  function zipWrite(files){
    // files: Map<string, Uint8Array>
    const locals=[], offsets=[], list=[...files.entries()];
    let off=0;
    for(const[name,data]of list){
      const nb=enc.encode(name), crc=crc32(data);
      offsets.push(off);
      const lh=cat([0x50,0x4B,0x03,0x04],u16(20),u16(0),u16(0),u16(0),u16(0),u32(crc),u32(data.length),u32(data.length),u16(nb.length),u16(0),nb,data);
      locals.push(lh); off+=lh.length;
    }
    const cds=[]; let cdSz=0;
    list.forEach(([name,data],i)=>{
      const nb=enc.encode(name), crc=crc32(data);
      const cd=cat([0x50,0x4B,0x01,0x02],u16(20),u16(20),u16(0),u16(0),u16(0),u16(0),u32(crc),u32(data.length),u32(data.length),u16(nb.length),u16(0),u16(0),u16(0),u16(0),u32(0),u32(offsets[i]),nb);
      cds.push(cd); cdSz+=cd.length;
    });
    const eocd=cat([0x50,0x4B,0x05,0x06],u16(0),u16(0),u16(list.length),u16(list.length),u32(cdSz),u32(off),u16(0));
    return cat(...locals,...cds,eocd);
  }

  /* --- Ler ZIP --- */
  function zipRead(buf){
    const b=buf instanceof Uint8Array?buf:new Uint8Array(buf);
    const v=new DataView(b.buffer,b.byteOffset,b.byteLength);
    let epos=-1;
    for(let i=b.length-22;i>=0;i--){if(b[i]===0x50&&b[i+1]===0x4B&&b[i+2]===0x05&&b[i+3]===0x06){epos=i;break;}}
    if(epos<0)throw new Error('ZIP inválido');
    const cnt=v.getUint16(epos+8,true), cdOff=v.getUint32(epos+16,true);
    const files=new Map(); let p=cdOff;
    for(let i=0;i<cnt;i++){
      if(b[p]!==0x50||b[p+1]!==0x4B||b[p+2]!==0x01||b[p+3]!==0x02)break;
      const nl=v.getUint16(p+28,true), el=v.getUint16(p+30,true), cl2=v.getUint16(p+32,true);
      const lo=v.getUint32(p+42,true);
      const name=dec.decode(b.slice(p+46,p+46+nl));
      const lnl=v.getUint16(lo+26,true), lel=v.getUint16(lo+28,true);
      const sz=v.getUint32(lo+18,true), ds=lo+30+lnl+lel;
      files.set(name,b.slice(ds,ds+sz));
      p+=46+nl+el+cl2;
    }
    return files;
  }

  /* --- Utilitários OOXML --- */
  function esc(s){return String(s??'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');}
  function colLetter(c){let s='',n=c+1;while(n>0){n--;s=String.fromCharCode(65+n%26)+s;n=Math.floor(n/26);}return s;}
  function cellRef(c,r){return colLetter(c)+(r+1);}

  /* --- Escrever XLSX --- */
  function write(sheets){
    // sheets: [{name:string, data:object[]}]
    const ss=[], ssMap=new Map();
    function si(v){const k=String(v??'');if(ssMap.has(k))return ssMap.get(k);const i=ss.length;ss.push(k);ssMap.set(k,i);return i;}

    const files=new Map();

    // [Content_Types].xml
    let ct=`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/><Override PartName="/xl/sharedStrings.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml"/>`;
    sheets.forEach((_,i)=>ct+=`<Override PartName="/xl/worksheets/sheet${i+1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`);
    ct+=`</Types>`;
    files.set('[Content_Types].xml',enc.encode(ct));

    files.set('_rels/.rels',enc.encode(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`));

    let wbx=`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>`;
    sheets.forEach((s,i)=>wbx+=`<sheet name="${esc(s.name)}" sheetId="${i+1}" r:id="rId${i+1}"/>`);
    wbx+=`</sheets></workbook>`;
    files.set('xl/workbook.xml',enc.encode(wbx));

    let wr=`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">`;
    sheets.forEach((_,i)=>wr+=`<Relationship Id="rId${i+1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i+1}.xml"/>`);
    wr+=`<Relationship Id="rId${sheets.length+1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/sharedStrings" Target="sharedStrings.xml"/></Relationships>`;
    files.set('xl/_rels/workbook.xml.rels',enc.encode(wr));

    files.set('xl/styles.xml',enc.encode(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><fonts count="1"><font><sz val="11"/><name val="Calibri"/></font></fonts><fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills><borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/></cellXfs></styleSheet>`));

    // Worksheets
    sheets.forEach((sheet,si2)=>{
      const rows=sheet.data&&sheet.data.length?sheet.data:[{'info':'Sem dados'}];
      const keys=Object.keys(rows[0]);
      let ws=`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>`;
      // cabeçalho
      ws+=`<row r="1">`;
      keys.forEach((k,ci)=>ws+=`<c r="${cellRef(ci,0)}" t="s"><v>${si(k)}</v></c>`);
      ws+=`</row>`;
      // dados
      rows.forEach((row,ri)=>{
        ws+=`<row r="${ri+2}">`;
        keys.forEach((k,ci)=>{
          const val=row[k]; const addr=cellRef(ci,ri+1);
          if(val===null||val===undefined||val===''){ws+=`<c r="${addr}"/>`;
          }else if(typeof val==='number'){ws+=`<c r="${addr}"><v>${val}</v></c>`;
          }else{ws+=`<c r="${addr}" t="s"><v>${si(val)}</v></c>`;}
        });
        ws+=`</row>`;
      });
      ws+=`</sheetData></worksheet>`;
      files.set(`xl/worksheets/sheet${si2+1}.xml`,enc.encode(ws));
    });

    // sharedStrings — tem de ser construído depois de todos os worksheets
    let ssx=`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="${ss.length}" uniqueCount="${ss.length}">`;
    ss.forEach(s=>ssx+=`<si><t xml:space="preserve">${esc(s)}</t></si>`);
    ssx+=`</sst>`;
    files.set('xl/sharedStrings.xml',enc.encode(ssx));

    return zipWrite(files);
  }

  /* --- Ler XLSX --- */
  function read(arrayBuffer){
    const files=zipRead(new Uint8Array(arrayBuffer));
    const parser=new DOMParser();
    function parseXML(bytes){ return parser.parseFromString(dec.decode(bytes||new Uint8Array()),'application/xml'); }

    // Shared strings
    const ssDoc=parseXML(files.get('xl/sharedStrings.xml'));
    const ssList=[...ssDoc.querySelectorAll('si')].map(el=>{
      // concat all <t> inside <si>, handling <r><t> rich-text
      return [...el.querySelectorAll('t')].map(t=>t.textContent).join('');
    });

    // Workbook — sheet names
    const wbDoc=parseXML(files.get('xl/workbook.xml'));
    const sheetEls=[...wbDoc.querySelectorAll('sheet')];

    const result={};
    sheetEls.forEach((shEl,i)=>{
      const shName=shEl.getAttribute('name')||`Sheet${i+1}`;
      const wsBytes=files.get(`xl/worksheets/sheet${i+1}.xml`);
      if(!wsBytes){result[shName]=[];return;}
      const wsDoc=parseXML(wsBytes);

      const grid={};
      [...wsDoc.querySelectorAll('row')].forEach(rowEl=>{
        const ri=parseInt(rowEl.getAttribute('r'),10)-1;
        if(!grid[ri])grid[ri]={};
        [...rowEl.querySelectorAll('c')].forEach(cel=>{
          const ref=cel.getAttribute('r')||'';
          const colStr=ref.replace(/[0-9]/g,'');
          let ci=0;
          for(let k=0;k<colStr.length;k++)ci=ci*26+(colStr.charCodeAt(k)-64);
          ci--;
          const t=cel.getAttribute('t');
          const vEl=cel.querySelector('v');
          if(!vEl){grid[ri][ci]='';return;}
          const raw=vEl.textContent;
          if(t==='s'){grid[ri][ci]=ssList[parseInt(raw,10)]??'';}
          else if(t==='b'){grid[ri][ci]=raw==='1'?true:false;}
          else{const n=Number(raw);grid[ri][ci]=isNaN(n)?raw:n;}
        });
      });

      const rowIdxs=Object.keys(grid).map(Number).sort((a,b)=>a-b);
      if(!rowIdxs.length){result[shName]=[];return;}
      const maxCols=Math.max(...rowIdxs.map(r=>Math.max(-1,...Object.keys(grid[r]).map(Number))))+1;
      const toArr=ri=>{const a=[];for(let c=0;c<maxCols;c++)a.push(grid[ri]?.[c]??'');return a;};

      const hdr=toArr(rowIdxs[0]);
      const rows=rowIdxs.slice(1).map(ri=>{
        const arr=toArr(ri);
        const obj={};
        hdr.forEach((h,ci)=>{if(h!==''&&h!==undefined)obj[String(h)]=arr[ci]??'';});
        return obj;
      }).filter(o=>Object.values(o).some(v=>v!==''&&v!==undefined));
      result[shName]=rows;
    });
    return result;
  }

  /* --- API pública --- */
  function download(sheets, filename){
    // sheets: [{name:string, data:object[]}]
    try{
      const bytes=write(sheets);
      const blob=new Blob([bytes],{type:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'});
      const url=URL.createObjectURL(blob);
      const a=document.createElement('a');
      a.href=url; a.download=filename;
      document.body.appendChild(a); a.click(); document.body.removeChild(a);
      setTimeout(()=>URL.revokeObjectURL(url),3000);
      return true;
    }catch(e){toast('error','Erro no download XLSX',e.message);return false;}
  }

  return {write, read, download};
})();
// ===================== FIM XLSX PURO =====================

// ===================== SVG ICONS =====================
const ICONS = {
  medical:`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M8 21h12a2 2 0 0 0 2-2v-2H10v2a2 2 0 0 1-2 2zm14-6H2V9a2 2 0 0 1 2-2h4V5a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2h4a2 2 0 0 1 2 2v6z"/><path d="M12 11v4M10 13h4"/></svg>`,
  dashboard:`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/></svg>`,
  pill:`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10.5 20H4a2 2 0 0 1-2-2V5c0-1.1.9-2 2-2h3.93a2 2 0 0 1 1.66.9l.82 1.2a2 2 0 0 0 1.66.9H20a2 2 0 0 1 2 2v3"/><circle cx="18" cy="18" r="4"/><path d="m15.4 20.6 5.2-5.2"/></svg>`,
  supplier:`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 9h18v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V9z"/><path d="M3 9V6a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v3"/><path d="M12 12v5"/><path d="M8 12v5"/><path d="M16 12v5"/></svg>`,
  shelf:`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="3" width="20" height="3" rx="1"/><rect x="2" y="10" width="20" height="3" rx="1"/><rect x="2" y="17" width="20" height="3" rx="1"/><path d="M6 6v4M10 6v4M14 6v4M18 6v4M6 13v4M10 13v4M14 13v4M18 13v4"/></svg>`,
  lot:`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 7H4a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2z"/><path d="M16 21V5a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v16"/></svg>`,
  movement:`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M7 16V4m0 0L3 8m4-4 4 4"/><path d="M17 8v12m0 0 4-4m-4 4-4-4"/></svg>`,
  alert:`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>`,
  report:`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/><polyline points="10 9 9 9 8 9"/></svg>`,
  database:`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><ellipse cx="12" cy="5" rx="9" ry="3"/><path d="M21 12c0 1.66-4 3-9 3s-9-1.34-9-3"/><path d="M3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5"/></svg>`,
  plus:`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>`,
  edit:`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>`,
  trash:`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6M14 11v6"/><path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/></svg>`,
  eye:`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>`,
  search:`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>`,
  download:`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>`,
  upload:`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>`,
  logout:`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/></svg>`,
  x:`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>`,
  check:`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>`,
  chevron_left:`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 18 9 12 15 6"/></svg>`,
  chevron_right:`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6"/></svg>`,
  bell:`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.73 21a2 2 0 0 1-3.46 0"/></svg>`,
  user:`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>`,
  users:`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>`,
  lock:`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>`,
  eye_off:`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94"/><path d="M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19"/><line x1="1" y1="1" x2="23" y2="23"/></svg>`,
  refresh:`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="23 4 23 10 17 10"/><polyline points="1 20 1 14 7 14"/><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/></svg>`,
  calendar:`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="18" rx="2" ry="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></svg>`,
  package:`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="16.5" y1="9.4" x2="7.5" y2="4.21"/><path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/><polyline points="3.27 6.96 12 12.01 20.73 6.96"/><line x1="12" y1="22.08" x2="12" y2="12"/></svg>`,
  arrow_up:`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="19" x2="12" y2="5"/><polyline points="5 12 12 5 19 12"/></svg>`,
  arrow_down:`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="5" x2="12" y2="19"/><polyline points="19 12 12 19 5 12"/></svg>`,
  barcode:`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 5v14M8 5v14M12 5v14M17 5v14M21 5v14M3 5h2M3 19h2M19 5h2M19 19h2"/></svg>`,
  map_pin:`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"/><circle cx="12" cy="10" r="3"/></svg>`,
  phone:`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07A19.5 19.5 0 0 1 4.07 11.5 19.79 19.79 0 0 1 1 2.84A2 2 0 0 1 3 .66h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L7.09 8.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92z"/></svg>`,
  mail:`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z"/><polyline points="22,6 12,13 2,6"/></svg>`,
  info:`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/></svg>`,
  settings:`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>`,
  trending_up:`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="23 6 13.5 15.5 8.5 10.5 1 18"/><polyline points="17 6 23 6 23 12"/></svg>`,
  list:`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="8" y1="6" x2="21" y2="6"/><line x1="8" y1="12" x2="21" y2="12"/><line x1="8" y1="18" x2="21" y2="18"/><line x1="3" y1="6" x2="3.01" y2="6"/><line x1="3" y1="12" x2="3.01" y2="12"/><line x1="3" y1="18" x2="3.01" y2="18"/></svg>`,
  clock:`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>`,
  tag:`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20.59 13.41l-7.17 7.17a2 2 0 0 1-2.83 0L2 12V2h10l8.59 8.59a2 2 0 0 1 0 2.82z"/><line x1="7" y1="7" x2="7.01" y2="7"/></svg>`,
  layers:`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="12 2 2 7 12 12 22 7 12 2"/><polyline points="2 17 12 22 22 17"/><polyline points="2 12 12 17 22 12"/></svg>`,
  filter:`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="22 3 2 3 10 12.46 10 19 14 21 14 12.46 22 3"/></svg>`,
  box:`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/></svg>`,
  money:`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="1" x2="12" y2="23"/><path d="M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"/></svg>`,
  activity:`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/></svg>`,
  pie_chart:`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21.21 15.89A10 10 0 1 1 8 2.83"/><path d="M22 12A10 10 0 0 0 12 2v10z"/></svg>`,
  bar_chart:`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="20" x2="18" y2="10"/><line x1="12" y1="20" x2="12" y2="4"/><line x1="6" y1="20" x2="6" y2="14"/><line x1="2" y1="20" x2="22" y2="20"/></svg>`,
  sync:`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="23 4 23 10 17 10"/><polyline points="1 20 1 14 7 14"/><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/></svg>`,
  cloud:`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 10h-1.26A8 8 0 1 0 9 20h9a5 5 0 0 0 0-10z"/></svg>`,
  shield:`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>`,
};

function icon(name, cls='') {
  return `<span class="${cls}" style="display:inline-flex;align-items:center;">${ICONS[name]||''}</span>`;
}

// ===================== CRYPTO UTILITIES =====================
async function hashPassword(pwd) {
  const encoder = new TextEncoder();
  const data = encoder.encode(pwd);
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
}

// ===================== DATABASE =====================
const DB_KEY = 'hmm_db_v2';

// Empty database — credentials are NEVER in source code
const DEFAULT_DB = {
  usuarios: [],        // Populated via first-run setup wizard
  produtos: [],
  fornecedores: [],
  prateleiras: [],
  lotes: [],
  movimentacoes: []
};

class Database {
  constructor() { this.data = this.load(); }
  load() {
    try {
      const raw = localStorage.getItem(DB_KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        // Ensure all tables exist
        const base = JSON.parse(JSON.stringify(DEFAULT_DB));
        return { ...base, ...parsed };
      }
      return JSON.parse(JSON.stringify(DEFAULT_DB));
    } catch { return JSON.parse(JSON.stringify(DEFAULT_DB)); }
  }
  save() { localStorage.setItem(DB_KEY, JSON.stringify(this.data)); }
  nextId(table) {
    const items = this.data[table];
    return items.length ? Math.max(...items.map(i => i.id)) + 1 : 1;
  }
  getAll(table, includeDeleted=false) {
    return (this.data[table]||[]).filter(r => includeDeleted || r.ativo !== false);
  }
  getById(table, id) { return (this.data[table]||[]).find(r => r.id === id); }
  insert(table, item) {
    item.id = this.nextId(table);
    item.ativo = true;
    this.data[table].push(item);
    this.save();
    return item;
  }
  update(table, id, updates) {
    const idx = this.data[table].findIndex(r => r.id === id);
    if (idx === -1) return false;
    this.data[table][idx] = { ...this.data[table][idx], ...updates };
    this.save();
    return true;
  }
  remove(table, id) { return this.update(table, id, { ativo: false }); }
  clear() {
    this.data = { ...JSON.parse(JSON.stringify(DEFAULT_DB)), usuarios: this.data.usuarios };
    this.save();
  }
  getStock(produtoId) {
    const movs = this.getAll('movimentacoes').filter(m => m.produto_id === produtoId);
    const entradas = movs.filter(m=>m.tipo==='Entrada').reduce((s,m)=>s+(m.quantidade||0),0);
    const saidas = movs.filter(m=>m.tipo==='Saída').reduce((s,m)=>s+(m.quantidade||0),0);
    return { entradas, saidas, stock: entradas - saidas };
  }
  getShelfCount(prateleiraId) {
    return this.getAll('produtos').filter(p=>p.prateleira_id===prateleiraId).length;
  }
}

const db = new Database();

// ===================== APP STATE =====================
let currentUser = null;
let currentPage = 'dashboard';
let sidebarCollapsed = false;
let editingId = null;
const chartInstances = {};

// ===================== UTILITIES =====================
function formatDate(d) {
  if (!d) return '—';
  try { return new Date(d).toLocaleDateString('pt-AO',{day:'2-digit',month:'2-digit',year:'numeric'}); }
  catch { return d; }
}
function formatMoney(v) {
  if (!v && v !== 0) return '—';
  return Number(v).toLocaleString('pt-AO') + ' AOA';
}
function today() { return new Date().toISOString().split('T')[0]; }
function daysUntil(dateStr) {
  if (!dateStr) return Infinity;
  return Math.floor((new Date(dateStr) - new Date()) / 86400000);
}
function getLotStatus(validade) {
  const d = daysUntil(validade);
  if (d < 0) return { label:'Vencido', cls:'badge-danger' };
  if (d <= 90) return { label:'A Vencer', cls:'badge-warning' };
  return { label:'Activo', cls:'badge-success' };
}
function initials(name) {
  return (name||'U').split(' ').slice(0,2).map(w=>w[0]).join('').toUpperCase();
}
function destroyChart(id) {
  if (chartInstances[id]) { chartInstances[id].destroy(); delete chartInstances[id]; }
}

// Toast
function toast(type, title, msg='') {
  const iconMap = {success:'check',error:'x',warning:'alert',info:'info'};
  const container = document.getElementById('toast-container');
  const t = document.createElement('div');
  t.className = `toast t-${type}`;
  t.innerHTML = `
    <div class="toast-icon">${ICONS[iconMap[type]]||''}</div>
    <div class="toast-content">
      <div class="toast-title">${title}</div>
      ${msg?`<div class="toast-msg">${msg}</div>`:''}
    </div>
    <button class="toast-close">${ICONS.x}</button>`;
  t.querySelector('.toast-close').onclick = () => t.remove();
  container.appendChild(t);
  setTimeout(() => { t.style.opacity='0'; t.style.transform='translateX(20px)'; t.style.transition='all 0.3s'; setTimeout(()=>t.remove(),300); }, 4200);
}

// Confirm dialog
let confirmResolve = null;
function confirm(title, msg) {
  return new Promise(resolve => {
    confirmResolve = resolve;
    document.getElementById('confirm-title').textContent = title;
    document.getElementById('confirm-msg').textContent = msg;
    document.getElementById('confirm-overlay').classList.add('open');
  });
}

function setLoading(btn, loading) {
  if (loading) { btn.classList.add('loading'); btn.disabled = true; }
  else { btn.classList.remove('loading'); btn.disabled = false; }
}

// ===================== SPLASH =====================
function startSplash() {
  const messages = ['Inicializando sistema...','Verificando base de dados...','Carregando configurações...','Preparando interface...','Sistema pronto!'];
  const fill = document.getElementById('splash-fill');
  const label = document.getElementById('splash-label');
  let step = 0;
  const particles = document.getElementById('splash-particles');
  for (let i=0;i<20;i++) {
    const p = document.createElement('div');
    p.className = 'splash-particle';
    const size = Math.random()*8+4;
    p.style.cssText = `width:${size}px;height:${size}px;left:${Math.random()*100}%;background:${Math.random()>0.5?'rgba(0,184,148,0.3)':'rgba(10,36,99,0.5)'};animation-duration:${Math.random()*6+5}s;animation-delay:${Math.random()*4}s;--drift:${(Math.random()-0.5)*200}px;`;
    particles.appendChild(p);
  }
  const interval = setInterval(() => {
    step++;
    fill.style.width = Math.min((step/messages.length)*100,100)+'%';
    label.textContent = messages[Math.min(step,messages.length-1)];
    if (step >= messages.length) {
      clearInterval(interval);
      setTimeout(() => {
        document.getElementById('splash').style.opacity='0';
        document.getElementById('splash').style.transition='opacity 0.5s ease';
        setTimeout(() => {
          // First run check
          if (db.data.usuarios.length === 0) {
            showScreen('setup');
            setupFirstRun();
          } else {
            showScreen('login');
          }
        }, 500);
      }, 500);
    }
  }, 550);
}

// ===================== SCREEN MANAGEMENT =====================
function showScreen(name) {
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  const screen = document.getElementById(name);
  if (screen) screen.classList.add('active');
}

// ===================== FIRST RUN SETUP =====================
function setupFirstRun() {
  const form = document.getElementById('setup-form');
  const errBox = document.getElementById('setup-error');
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    errBox.classList.remove('show');
    const nome = document.getElementById('setup-nome').value.trim();
    const username = document.getElementById('setup-username').value.trim();
    const pwd = document.getElementById('setup-pwd').value;
    const pwd2 = document.getElementById('setup-pwd2').value;
    if (!nome || !username) { errBox.textContent='Nome e utilizador são obrigatórios.'; errBox.classList.add('show'); return; }
    if (pwd.length < 6) { errBox.textContent='A senha deve ter pelo menos 6 caracteres.'; errBox.classList.add('show'); return; }
    if (pwd !== pwd2) { errBox.textContent='As senhas não coincidem.'; errBox.classList.add('show'); return; }
    if (db.data.usuarios.find(u=>u.username===username)) { errBox.textContent='Nome de utilizador já existe.'; errBox.classList.add('show'); return; }
    const btn = document.getElementById('setup-btn');
    setLoading(btn, true);
    const hashed = await hashPassword(pwd);
    db.insert('usuarios', { username, senha: hashed, nome, funcao:'Administrador' });
    setLoading(btn, false);
    toast('success','Conta criada!','Pode agora fazer login.');
    showScreen('login');
  });
}

// ===================== LOGIN =====================
function setupLogin() {
  const form = document.getElementById('login-form');
  const pwdInput = document.getElementById('pwd-input');
  const toggleBtn = document.getElementById('pwd-toggle');
  const errorBox = document.getElementById('login-error');

  toggleBtn.addEventListener('click', () => {
    const isText = pwdInput.type === 'text';
    pwdInput.type = isText ? 'password' : 'text';
    toggleBtn.innerHTML = isText ? ICONS.eye : ICONS.eye_off;
  });

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = document.getElementById('login-btn');
    const username = document.getElementById('user-input').value.trim();
    const pwd = pwdInput.value;
    errorBox.classList.remove('show');
    setLoading(btn, true);
    await new Promise(r=>setTimeout(r,700));

    // Find user and compare hashed password
    const hashed = await hashPassword(pwd);
    const found = db.data.usuarios.find(u => u.username === username && u.senha === hashed && u.ativo !== false);
    if (found) {
      currentUser = found;
      setLoading(btn, false);
      document.getElementById('login').style.opacity='0';
      document.getElementById('login').style.transition='opacity 0.4s ease';
      setTimeout(() => { showScreen('app'); initApp(); }, 400);
    } else {
      setLoading(btn, false);
      errorBox.textContent = 'Utilizador ou senha incorrectos.';
      errorBox.classList.add('show');
    }
  });
}

// ===================== APP INIT =====================
function initApp() {
  document.getElementById('header-user-name').textContent = currentUser.nome;
  document.getElementById('header-user-role').textContent = currentUser.funcao;
  document.getElementById('header-user-avatar').textContent = initials(currentUser.nome);
  document.getElementById('sidebar-user-name').textContent = currentUser.nome;
  document.getElementById('sidebar-user-role').textContent = currentUser.funcao;
  document.getElementById('sidebar-user-avatar').textContent = initials(currentUser.nome);

  // Show/hide admin menu based on role
  const navUsuarios = document.getElementById('nav-usuarios');
  if (navUsuarios) {
    navUsuarios.style.display = currentUser.funcao === 'Administrador' ? 'flex' : 'none';
  }

  setupSidebar();
  setupNavigation();
  updateAlertBadge();
  navigateTo('dashboard');
}

// ===================== SIDEBAR =====================
function setupSidebar() {
  const sidebar = document.getElementById('sidebar');
  document.getElementById('sidebar-toggle').addEventListener('click', () => {
    sidebarCollapsed = !sidebarCollapsed;
    sidebar.classList.toggle('collapsed', sidebarCollapsed);
  });
  document.getElementById('sidebar-user').addEventListener('click', () => {
    confirm('Terminar Sessão','Deseja terminar a sessão actual?').then(ok => {
      if (ok) {
        currentUser = null;
        // Destroy all charts before leaving
        Object.keys(chartInstances).forEach(k => destroyChart(k));
        showScreen('login');
        document.getElementById('login').style.opacity='1';
        document.getElementById('login-form').reset();
        document.getElementById('login-error').classList.remove('show');
      }
    });
  });
}

// ===================== NAVIGATION =====================
function setupNavigation() {
  document.querySelectorAll('.nav-item').forEach(item => {
    item.addEventListener('click', () => {
      const page = item.dataset.page;
      if (page) navigateTo(page);
    });
  });
}

const PAGE_TITLES = {
  dashboard:'Dashboard', produtos:'Cadastro de Produtos', fornecedores:'Fornecedores',
  prateleiras:'Prateleiras', lotes:'Cadastro de Lotes', movimentacoes:'Entradas / Saídas',
  alertas:'Alertas', relatorios:'Relatórios', basedados:'Base de Dados',
  usuarios:'Utilizadores', sincronizacao:'Sincronização',
};

function navigateTo(page) {
  currentPage = page;
  document.querySelectorAll('.nav-item').forEach(item => {
    item.classList.toggle('active', item.dataset.page === page);
  });
  document.getElementById('header-page-title').textContent = PAGE_TITLES[page]||page;
  document.getElementById('header-breadcrumb-current').textContent = PAGE_TITLES[page]||page;
  document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
  const pageEl = document.getElementById('page-'+page);
  if (pageEl) pageEl.classList.add('active');
  renderPage(page);
}

function renderPage(page) {
  const renders = {
    dashboard:renderDashboard, produtos:renderProdutos, fornecedores:renderFornecedores,
    prateleiras:renderPrateleiras, lotes:renderLotes, movimentacoes:renderMovimentacoes,
    alertas:renderAlertas, relatorios:renderRelatorios, basedados:renderBaseDados,
    usuarios:renderUsuarios, sincronizacao:renderSincronizacao,
  };
  if (renders[page]) renders[page]();
}

// ===================== ALERT BADGE =====================
function updateAlertBadge() {
  const alertas = getAlerts();
  const badge = document.getElementById('nav-badge-alertas');
  const headerBadge = document.getElementById('header-notif-badge');
  const count = alertas.length;
  if (badge) { badge.textContent = count||''; badge.style.display = count>0?'flex':'none'; }
  if (headerBadge) { headerBadge.textContent = count||''; headerBadge.style.display = count>0?'flex':'none'; }
}

function getAlerts() {
  const alerts = [];
  db.getAll('lotes').forEach(lot => {
    const d = daysUntil(lot.validade);
    const prod = db.getById('produtos', lot.produto_id);
    const name = prod ? prod.nome : `Produto #${lot.produto_id}`;
    if (d < 0) alerts.push({type:'err',icon:'alert',title:`Lote vencido: ${lot.numero_lote}`,desc:`${name} — Vencido há ${Math.abs(d)} dias`,time:formatDate(lot.validade)});
    else if (d <= 90) alerts.push({type:'warn',icon:'clock',title:`Lote a vencer: ${lot.numero_lote}`,desc:`${name} — Vence em ${d} dias`,time:formatDate(lot.validade)});
  });
  db.getAll('produtos').forEach(prod => {
    const {stock} = db.getStock(prod.id);
    if (prod.stock_minimo && stock <= prod.stock_minimo) {
      alerts.push({type:'warn',icon:'package',title:`Stock mínimo: ${prod.nome}`,desc:`Stock actual: ${stock} unid. (Mínimo: ${prod.stock_minimo})`,time:'Agora'});
    }
  });
  return alerts;
}

// ===================== STAT CARD =====================
function statCard(label, value, ico, color, rgb, sub) {
  return `<div class="stat-card">
    <div class="stat-icon" style="background:rgba(${rgb},0.15);color:${color};">${ICONS[ico]||''}</div>
    <div class="stat-info">
      <div class="stat-value" style="color:${color};">${value}</div>
      <div class="stat-label">${label}</div>
      <div class="stat-sub">${sub}</div>
    </div>
  </div>`;
}

// ===================== DASHBOARD PAGE =====================
let dashChartPeriod = 'month'; // 'day' | 'month' | 'year'

function renderDashboard() {
  const produtos = db.getAll('produtos');
  const fornecedores = db.getAll('fornecedores');
  const prateleiras = db.getAll('prateleiras');
  const lotes = db.getAll('lotes');
  const movs = db.getAll('movimentacoes');

  const totalEntradas = movs.filter(m=>m.tipo==='Entrada').reduce((s,m)=>s+m.quantidade,0);
  const totalSaidas = movs.filter(m=>m.tipo==='Saída').reduce((s,m)=>s+m.quantidade,0);
  const alerts = getAlerts();

  const topProd = produtos.map(p => {
    const {stock} = db.getStock(p.id);
    return {...p, stock};
  }).sort((a,b)=>b.stock-a.stock).slice(0,5);

  const recentMovs = [...movs].sort((a,b)=>new Date(b.data)-new Date(a.data)).slice(0,7);

  document.getElementById('page-dashboard').innerHTML = `
    <div class="stats-grid">
      ${statCard('Produtos',produtos.length,'pill','#00B894','0,184,148','Total cadastrados')}
      ${statCard('Total Entradas',totalEntradas,'arrow_up','#27AE60','39,174,96','Unidades entradas')}
      ${statCard('Total Saídas',totalSaidas,'arrow_down','#E74C3C','231,76,60','Unidades saídas')}
      ${statCard('Lotes',lotes.length,'lot','#3498DB','52,152,219','Lotes registados')}
      ${statCard('Prateleiras',prateleiras.length,'shelf','#9B59B6','155,89,182','Prateleiras activas')}
      ${statCard('Fornecedores',fornecedores.length,'supplier','#F39C12','243,156,18','Fornecedores activos')}
      ${statCard('Alertas',alerts.length,'alert',alerts.length>0?'#E74C3C':'#27AE60',alerts.length>0?'231,76,60':'39,174,96','Alertas activos')}
    </div>

    <!-- CHARTS ROW -->
    <div class="charts-row">
      <div class="chart-card">
        <div class="chart-title">
          ${ICONS.bar_chart} Consumo de Medicamentos
          <div class="chart-period-btns">
            <button class="chart-period-btn ${dashChartPeriod==='day'?'active':''}" onclick="setDashPeriod('day')">Dia</button>
            <button class="chart-period-btn ${dashChartPeriod==='month'?'active':''}" onclick="setDashPeriod('month')">Mês</button>
            <button class="chart-period-btn ${dashChartPeriod==='year'?'active':''}" onclick="setDashPeriod('year')">Ano</button>
          </div>
        </div>
        <div class="chart-container">
          <canvas id="chart-consumo"></canvas>
        </div>
      </div>
      <div class="chart-card">
        <div class="chart-title">${ICONS.pie_chart} Distribuição por Grupo Farmacológico</div>
        <div class="chart-container">
          <canvas id="chart-grupos"></canvas>
        </div>
      </div>
    </div>
    <div class="charts-row">
      <div class="chart-card">
        <div class="chart-title">${ICONS.pie_chart} Entradas vs Saídas</div>
        <div class="chart-container">
          <canvas id="chart-entradas-saidas"></canvas>
        </div>
      </div>
      <div class="chart-card">
        <div class="chart-title">${ICONS.bar_chart} Top 5 Produtos por Stock</div>
        <div class="chart-container">
          <canvas id="chart-top-stock"></canvas>
        </div>
      </div>
    </div>

    <!-- TABLES ROW -->
    <div class="grid-2-1" style="gap:20px;margin-bottom:20px;">
      <div>
        <div class="dash-section-title">${ICONS.activity} Últimas Movimentações</div>
        <div class="table-wrap">
          <div class="tbl-scroll">
          <table>
            <thead><tr><th>Produto</th><th>Tipo</th><th>Qtd</th><th>Destino</th><th>Data</th></tr></thead>
            <tbody>
              ${recentMovs.length ? recentMovs.map(m => {
                const p = db.getById('produtos', m.produto_id);
                return `<tr>
                  <td class="td-name">${p?p.nome:'—'}</td>
                  <td><span class="badge ${m.tipo==='Entrada'?'badge-success':'badge-danger'}">${m.tipo}</span></td>
                  <td class="font-bold">${m.quantidade}</td>
                  <td>${m.destino||'—'}</td>
                  <td>${formatDate(m.data)}</td>
                </tr>`;
              }).join('') : `<tr><td colspan="5" class="table-empty"><p>Sem movimentações registadas</p></td></tr>`}
            </tbody>
          </table>
          </div>
        </div>
      </div>
      <div>
        <div class="dash-section-title">${ICONS.alert} Alertas Recentes</div>
        <div class="table-wrap">
          ${alerts.slice(0,5).map(a => `
            <div class="alert-item">
              <div class="alert-icon ${a.type}">${ICONS[a.icon]||ICONS.alert}</div>
              <div class="alert-content">
                <div class="alert-title">${a.title}</div>
                <div class="alert-desc">${a.desc}</div>
                <div class="alert-time">${a.time}</div>
              </div>
            </div>
          `).join('') || `<div class="table-empty">${ICONS.check}<p>Sem alertas activos</p></div>`}
        </div>
      </div>
    </div>
  `;

  // Initialize charts after DOM is ready
  setTimeout(() => initDashboardCharts(movs, produtos), 0);
}

function setDashPeriod(period) {
  dashChartPeriod = period;
  renderDashboard();
}

function initDashboardCharts(movs, produtos) {
  const CHART_COLORS = {
    entrada: 'rgba(39,174,96,0.85)', saida: 'rgba(231,76,60,0.85)',
    border_entrada: '#27AE60', border_saida: '#E74C3C',
  };
  const PALETTE = ['#00B894','#3498DB','#9B59B6','#F39C12','#E74C3C','#1ABC9C','#E67E22','#2ECC71'];

  Chart.defaults.color = '#8BA7C7';
  Chart.defaults.borderColor = '#1E3A5F';

  // --- Chart 1: Consumo por período ---
  destroyChart('chart-consumo');
  const ctx1 = document.getElementById('chart-consumo');
  if (ctx1) {
    const { labels, entradas, saidas } = buildPeriodData(movs, dashChartPeriod);
    chartInstances['chart-consumo'] = new Chart(ctx1, {
      type: 'bar',
      data: {
        labels,
        datasets: [
          { label:'Entradas', data: entradas, backgroundColor: CHART_COLORS.entrada, borderColor: CHART_COLORS.border_entrada, borderWidth:1, borderRadius:4 },
          { label:'Saídas', data: saidas, backgroundColor: CHART_COLORS.saida, borderColor: CHART_COLORS.border_saida, borderWidth:1, borderRadius:4 }
        ]
      },
      options: {
        responsive:true, maintainAspectRatio:false,
        plugins:{ legend:{ labels:{ color:'#8BA7C7', font:{size:11} } } },
        scales:{
          x:{ ticks:{ color:'#5A7A9B', font:{size:10} }, grid:{ color:'rgba(30,58,95,0.5)' } },
          y:{ ticks:{ color:'#5A7A9B', font:{size:10} }, grid:{ color:'rgba(30,58,95,0.5)' }, beginAtZero:true }
        }
      }
    });
  }

  // --- Chart 2: Distribuição por grupo farmacológico (doughnut) ---
  destroyChart('chart-grupos');
  const ctx2 = document.getElementById('chart-grupos');
  if (ctx2) {
    const grupos = {};
    produtos.forEach(p => {
      const g = p.grupo_farmacologico || 'Outro';
      if (!grupos[g]) grupos[g] = 0;
      const {stock} = db.getStock(p.id);
      grupos[g] += Math.max(0, stock);
    });
    const gLabels = Object.keys(grupos);
    const gValues = gLabels.map(k => grupos[k]);
    if (gLabels.length === 0) { gLabels.push('Sem dados'); gValues.push(1); }
    chartInstances['chart-grupos'] = new Chart(ctx2, {
      type: 'doughnut',
      data: {
        labels: gLabels,
        datasets:[{ data:gValues, backgroundColor:PALETTE.slice(0,gLabels.length), borderWidth:2, borderColor:'#112240' }]
      },
      options:{
        responsive:true, maintainAspectRatio:false, cutout:'65%',
        plugins:{ legend:{ position:'right', labels:{ color:'#8BA7C7', font:{size:10}, padding:8 } } }
      }
    });
  }

  // --- Chart 3: Entradas vs Saídas total (doughnut) ---
  destroyChart('chart-entradas-saidas');
  const ctx3 = document.getElementById('chart-entradas-saidas');
  if (ctx3) {
    const totalE = movs.filter(m=>m.tipo==='Entrada').reduce((s,m)=>s+m.quantidade,0);
    const totalS = movs.filter(m=>m.tipo==='Saída').reduce((s,m)=>s+m.quantidade,0);
    const hasData = totalE > 0 || totalS > 0;
    chartInstances['chart-entradas-saidas'] = new Chart(ctx3, {
      type:'doughnut',
      data:{
        labels:['Entradas','Saídas'],
        datasets:[{ data: hasData ? [totalE,totalS] : [1,1], backgroundColor:[CHART_COLORS.entrada, CHART_COLORS.saida], borderWidth:2, borderColor:'#112240' }]
      },
      options:{
        responsive:true, maintainAspectRatio:false, cutout:'65%',
        plugins:{ legend:{ position:'right', labels:{ color:'#8BA7C7', font:{size:11}, padding:10 } } }
      }
    });
  }

  // --- Chart 4: Top 5 produtos por stock (horizontal bar) ---
  destroyChart('chart-top-stock');
  const ctx4 = document.getElementById('chart-top-stock');
  if (ctx4) {
    const topProd = produtos.map(p => {
      const {stock} = db.getStock(p.id);
      return { nome: p.nome.length > 22 ? p.nome.substring(0,20)+'…' : p.nome, stock: Math.max(0, stock) };
    }).sort((a,b)=>b.stock-a.stock).slice(0,5);
    chartInstances['chart-top-stock'] = new Chart(ctx4, {
      type:'bar',
      data:{
        labels: topProd.map(p=>p.nome),
        datasets:[{ label:'Stock Actual', data: topProd.map(p=>p.stock), backgroundColor: PALETTE, borderWidth:1, borderRadius:4 }]
      },
      options:{
        indexAxis:'y', responsive:true, maintainAspectRatio:false,
        plugins:{ legend:{ display:false } },
        scales:{
          x:{ ticks:{ color:'#5A7A9B', font:{size:10} }, grid:{ color:'rgba(30,58,95,0.5)' }, beginAtZero:true },
          y:{ ticks:{ color:'#8BA7C7', font:{size:10} }, grid:{ color:'rgba(30,58,95,0.5)' } }
        }
      }
    });
  }
}

function buildPeriodData(movs, period) {
  const now = new Date();
  let labels = [], entradas = [], saidas = [];

  if (period === 'day') {
    // Last 14 days
    for (let i=13; i>=0; i--) {
      const d = new Date(now); d.setDate(d.getDate()-i);
      const key = d.toISOString().split('T')[0];
      const label = d.toLocaleDateString('pt-AO',{day:'2-digit',month:'2-digit'});
      labels.push(label);
      const dayMovs = movs.filter(m=>m.data===key);
      entradas.push(dayMovs.filter(m=>m.tipo==='Entrada').reduce((s,m)=>s+m.quantidade,0));
      saidas.push(dayMovs.filter(m=>m.tipo==='Saída').reduce((s,m)=>s+m.quantidade,0));
    }
  } else if (period === 'month') {
    // Last 12 months
    const monthNames = ['Jan','Fev','Mar','Abr','Mai','Jun','Jul','Ago','Set','Out','Nov','Dez'];
    for (let i=11; i>=0; i--) {
      const d = new Date(now.getFullYear(), now.getMonth()-i, 1);
      const y = d.getFullYear(), m = d.getMonth();
      labels.push(monthNames[m]+' '+String(y).slice(2));
      const mMovs = movs.filter(mv=>{
        const md = new Date(mv.data);
        return md.getFullYear()===y && md.getMonth()===m;
      });
      entradas.push(mMovs.filter(m=>m.tipo==='Entrada').reduce((s,m)=>s+m.quantidade,0));
      saidas.push(mMovs.filter(m=>m.tipo==='Saída').reduce((s,m)=>s+m.quantidade,0));
    }
  } else {
    // Last 5 years
    for (let i=4; i>=0; i--) {
      const y = now.getFullYear()-i;
      labels.push(String(y));
      const yMovs = movs.filter(mv=>new Date(mv.data).getFullYear()===y);
      entradas.push(yMovs.filter(m=>m.tipo==='Entrada').reduce((s,m)=>s+m.quantidade,0));
      saidas.push(yMovs.filter(m=>m.tipo==='Saída').reduce((s,m)=>s+m.quantidade,0));
    }
  }
  return { labels, entradas, saidas };
}

// ===================== PRODUTOS PAGE =====================
let prodSearch = '';
function renderProdutos() {
  const prateleiras = db.getAll('prateleiras');
  let produtos = db.getAll('produtos');
  if (prodSearch) produtos = produtos.filter(p => p.nome.toLowerCase().includes(prodSearch.toLowerCase()) || (p.grupo_farmacologico||'').toLowerCase().includes(prodSearch.toLowerCase()));

  document.getElementById('page-produtos').innerHTML = `
    <div class="page-header">
      <div>
        <div class="page-title">${ICONS.pill} Cadastro de Produtos</div>
        <div class="page-title-sub">Gerir medicamentos e stocks</div>
      </div>
      <div class="page-actions">
        <button class="btn btn-primary" onclick="openProdutoModal()">
          ${ICONS.plus}<span class="btn-text-content">Novo Produto</span>
        </button>
      </div>
    </div>
    <div class="table-wrap">
      <div class="table-header">
        <div class="table-title">${ICONS.list} Lista de Produtos <span class="chip">${produtos.length}</span></div>
        <div class="table-actions">
          <div class="search-wrap">
            <span class="search-icon">${ICONS.search}</span>
            <input class="search-input" placeholder="Pesquisar produto..." value="${prodSearch}" oninput="prodSearch=this.value;renderProdutos()">
          </div>
        </div>
      </div>
      <div class="tbl-scroll">
      <table>
        <thead><tr>
          <th>Nome</th><th>Forma</th><th>Grupo Farmacológico</th><th>Prateleira</th>
          <th>Stock Mín.</th><th>Preço</th><th>Entradas</th><th>Saídas</th><th>Stock</th><th>Status</th><th>Acções</th>
        </tr></thead>
        <tbody>
          ${produtos.length ? produtos.map(p => {
            const {entradas,saidas,stock} = db.getStock(p.id);
            const prat = prateleiras.find(s=>s.id===p.prateleira_id);
            const belowMin = p.stock_minimo && stock <= p.stock_minimo;
            return `<tr>
              <td class="td-name">${p.nome}</td>
              <td>${p.forma||'—'}</td>
              <td>${p.grupo_farmacologico||'—'}</td>
              <td>${prat?prat.nome:'—'}</td>
              <td>${p.stock_minimo||'—'}</td>
              <td>${p.preco?formatMoney(p.preco):'—'}</td>
              <td class="text-accent font-bold">${entradas}</td>
              <td class="text-danger font-bold">${saidas}</td>
              <td class="font-bold ${belowMin?'text-danger':'text-accent'}">${stock}</td>
              <td><span class="badge ${belowMin?'badge-danger':'badge-success'}">${belowMin?'Stock Baixo':p.status||'Ativo'}</span></td>
              <td>
                <div style="display:flex;gap:5px;">
                  <button class="btn btn-secondary btn-icon" title="Editar" onclick="openProdutoModal(${p.id})">${ICONS.edit}</button>
                  <button class="btn btn-danger btn-icon" title="Eliminar" onclick="deleteProduto(${p.id})">${ICONS.trash}</button>
                </div>
              </td>
            </tr>`;
          }).join('') : `<tr><td colspan="11"><div class="table-empty">${ICONS.pill}<p>Nenhum produto cadastrado</p><p style="font-size:12px;color:var(--text-muted)">Clique em "Novo Produto" para começar</p></div></td></tr>`}
        </tbody>
      </table>
      </div>
    </div>

    <div class="modal-overlay" id="modal-produto">
      <div class="modal">
        <div class="modal-header">
          <div class="modal-title">${ICONS.pill} <span id="modal-prod-title">Novo Produto</span></div>
          <button class="modal-close" onclick="closeModal('modal-produto')">${ICONS.x}</button>
        </div>
        <div class="modal-body">
          <div class="form-grid form-grid-2">
            <div class="field-wrap form-grid-full">
              <label class="field-label">${ICONS.pill} Nome do Medicamento <span class="field-req">*</span></label>
              <input class="field-input" id="prod-nome" placeholder="Ex: Paracetamol 500mg" required>
            </div>
            <div class="field-wrap">
              <label class="field-label">${ICONS.tag} Forma Farmacêutica</label>
              <select class="field-select" id="prod-forma">
                <option value="">Seleccionar...</option>
                ${['Comprimido','Cápsula','Xarope','Injectável','Creme','Pomada','Supositório','Solução Oral','Gotas','Spray','Inalador','Sachê','Pó para Solução','Adesivo','Outro'].map(f=>`<option value="${f}">${f}</option>`).join('')}
              </select>
            </div>
            <div class="field-wrap">
              <label class="field-label">${ICONS.layers} Grupo Farmacológico</label>
              <select class="field-select" id="prod-grupo">
                <option value="">Seleccionar...</option>
                ${['Analgésico','Antibiótico','Anti-inflamatório','Antifúngico','Antiviral','Antiparasitário','Anti-hipertensivo','Antidiabético','Antiácido','Antihistamínico','Antidepressivo','Ansiolítico','Antiepiléptico','Cardiovascular','Diurético','Laxante','Vitamina/Suplemento','Anestésico','Antialérgico','Outro'].map(g=>`<option value="${g}">${g}</option>`).join('')}
              </select>
            </div>
            <div class="field-wrap">
              <label class="field-label">${ICONS.shelf} Prateleira</label>
              <select class="field-select" id="prod-prateleira">
                <option value="">Sem prateleira</option>
                ${prateleiras.map(s=>`<option value="${s.id}">${s.nome} (${s.seccao})</option>`).join('')}
              </select>
            </div>
            <div class="field-wrap">
              <label class="field-label">${ICONS.package} Stock Mínimo</label>
              <input class="field-input" id="prod-stock-min" type="number" min="0" placeholder="Ex: 50">
            </div>
            <div class="field-wrap">
              <label class="field-label">${ICONS.money} Preço (AOA)</label>
              <input class="field-input" id="prod-preco" type="number" min="0" step="0.01" placeholder="Ex: 500.00">
            </div>
          </div>
        </div>
        <div class="modal-footer">
          <button class="btn btn-secondary" onclick="closeModal('modal-produto')">Cancelar</button>
          <button class="btn btn-primary" id="btn-save-produto" onclick="saveProduto()">
            <span class="btn-spin"></span><span class="btn-text-content">${ICONS.check} Guardar</span>
          </button>
        </div>
      </div>
    </div>
  `;
}

function openProdutoModal(id=null) {
  editingId = id;
  document.getElementById('modal-prod-title').textContent = id?'Editar Produto':'Novo Produto';
  if (id) {
    const p = db.getById('produtos',id);
    if (p) {
      document.getElementById('prod-nome').value = p.nome||'';
      document.getElementById('prod-forma').value = p.forma||'';
      document.getElementById('prod-grupo').value = p.grupo_farmacologico||'';
      document.getElementById('prod-prateleira').value = p.prateleira_id||'';
      document.getElementById('prod-stock-min').value = p.stock_minimo||'';
      document.getElementById('prod-preco').value = p.preco||'';
    }
  } else {
    ['prod-nome','prod-stock-min','prod-preco'].forEach(id=>document.getElementById(id).value='');
    document.getElementById('prod-forma').value='';
    document.getElementById('prod-grupo').value='';
    document.getElementById('prod-prateleira').value='';
  }
  document.getElementById('modal-produto').classList.add('open');
}

async function saveProduto() {
  const nome = document.getElementById('prod-nome').value.trim();
  if (!nome) { toast('error','Nome obrigatório','Introduza o nome do medicamento'); return; }
  const btn = document.getElementById('btn-save-produto');
  setLoading(btn,true);
  await new Promise(r=>setTimeout(r,400));
  const data = {
    nome, forma:document.getElementById('prod-forma').value,
    grupo_farmacologico:document.getElementById('prod-grupo').value,
    prateleira_id:parseInt(document.getElementById('prod-prateleira').value)||null,
    stock_minimo:parseInt(document.getElementById('prod-stock-min').value)||null,
    preco:parseFloat(document.getElementById('prod-preco').value)||null, status:'Ativo',
  };
  if (editingId) { db.update('produtos',editingId,data); toast('success','Produto actualizado'); }
  else { db.insert('produtos',data); toast('success','Produto cadastrado'); }
  setLoading(btn,false);
  closeModal('modal-produto');
  renderProdutos();
  updateAlertBadge();
}

async function deleteProduto(id) {
  const p = db.getById('produtos',id);
  const ok = await confirm('Eliminar Produto',`Deseja eliminar "${p?.nome}"?`);
  if (ok) { db.remove('produtos',id); toast('success','Produto eliminado'); renderProdutos(); }
}

// ===================== FORNECEDORES PAGE =====================
let fornSearch = '';
function renderFornecedores() {
  let forns = db.getAll('fornecedores');
  if (fornSearch) forns = forns.filter(f=>f.nome.toLowerCase().includes(fornSearch.toLowerCase())||(f.contacto||'').toLowerCase().includes(fornSearch.toLowerCase()));

  document.getElementById('page-fornecedores').innerHTML = `
    <div class="page-header">
      <div>
        <div class="page-title">${ICONS.supplier} Fornecedores</div>
        <div class="page-title-sub">Gerir fornecedores de medicamentos</div>
      </div>
      <div class="page-actions">
        <button class="btn btn-primary" onclick="openFornecedorModal()">${ICONS.plus}<span class="btn-text-content">Novo Fornecedor</span></button>
      </div>
    </div>
    <div class="table-wrap">
      <div class="table-header">
        <div class="table-title">${ICONS.list} Lista de Fornecedores <span class="chip">${forns.length}</span></div>
        <div class="table-actions">
          <div class="search-wrap">
            <span class="search-icon">${ICONS.search}</span>
            <input class="search-input" placeholder="Pesquisar..." value="${fornSearch}" oninput="fornSearch=this.value;renderFornecedores()">
          </div>
        </div>
      </div>
      <div class="tbl-scroll">
      <table>
        <thead><tr><th>Nome</th><th>Contacto</th><th>Email</th><th>Telefone</th><th>Endereço</th><th>Acções</th></tr></thead>
        <tbody>
          ${forns.length ? forns.map(f=>`<tr>
            <td class="td-name">${f.nome}</td>
            <td>${f.contacto||'—'}</td>
            <td>${f.email||'—'}</td>
            <td>${f.telefone||'—'}</td>
            <td>${f.endereco||'—'}</td>
            <td>
              <div style="display:flex;gap:5px;">
                <button class="btn btn-secondary btn-icon" onclick="openFornecedorModal(${f.id})">${ICONS.edit}</button>
                <button class="btn btn-danger btn-icon" onclick="deleteFornecedor(${f.id})">${ICONS.trash}</button>
              </div>
            </td>
          </tr>`).join('') : `<tr><td colspan="6"><div class="table-empty">${ICONS.supplier}<p>Nenhum fornecedor cadastrado</p></div></td></tr>`}
        </tbody>
      </table>
      </div>
    </div>

    <div class="modal-overlay" id="modal-forn">
      <div class="modal">
        <div class="modal-header">
          <div class="modal-title">${ICONS.supplier} <span id="modal-forn-title">Novo Fornecedor</span></div>
          <button class="modal-close" onclick="closeModal('modal-forn')">${ICONS.x}</button>
        </div>
        <div class="modal-body">
          <div class="form-grid form-grid-2">
            <div class="field-wrap form-grid-full">
              <label class="field-label">${ICONS.supplier} Nome da Empresa <span class="field-req">*</span></label>
              <input class="field-input" id="forn-nome" placeholder="Ex: MedDistrib Lda">
            </div>
            <div class="field-wrap">
              <label class="field-label">${ICONS.user} Contacto</label>
              <input class="field-input" id="forn-contacto" placeholder="Ex: João Silva">
            </div>
            <div class="field-wrap">
              <label class="field-label">${ICONS.mail} Email</label>
              <input class="field-input" id="forn-email" type="email" placeholder="Ex: empresa@mail.com">
            </div>
            <div class="field-wrap">
              <label class="field-label">${ICONS.phone} Telefone</label>
              <input class="field-input" id="forn-tel" placeholder="Ex: 923 000 000">
            </div>
            <div class="field-wrap form-grid-full">
              <label class="field-label">${ICONS.map_pin} Endereço</label>
              <input class="field-input" id="forn-end" placeholder="Ex: Luanda, Angola">
            </div>
          </div>
        </div>
        <div class="modal-footer">
          <button class="btn btn-secondary" onclick="closeModal('modal-forn')">Cancelar</button>
          <button class="btn btn-primary" id="btn-save-forn" onclick="saveFornecedor()">
            <span class="btn-spin"></span><span class="btn-text-content">${ICONS.check} Guardar</span>
          </button>
        </div>
      </div>
    </div>
  `;
}

function openFornecedorModal(id=null) {
  editingId = id;
  document.getElementById('modal-forn-title').textContent = id?'Editar Fornecedor':'Novo Fornecedor';
  if (id) {
    const f = db.getById('fornecedores',id);
    if (f) {
      document.getElementById('forn-nome').value=f.nome||'';
      document.getElementById('forn-contacto').value=f.contacto||'';
      document.getElementById('forn-email').value=f.email||'';
      document.getElementById('forn-tel').value=f.telefone||'';
      document.getElementById('forn-end').value=f.endereco||'';
    }
  } else {
    ['forn-nome','forn-contacto','forn-email','forn-tel','forn-end'].forEach(i=>document.getElementById(i).value='');
  }
  document.getElementById('modal-forn').classList.add('open');
}

async function saveFornecedor() {
  const nome = document.getElementById('forn-nome').value.trim();
  if (!nome) { toast('error','Nome obrigatório'); return; }
  const btn = document.getElementById('btn-save-forn');
  setLoading(btn,true);
  await new Promise(r=>setTimeout(r,400));
  const data = {
    nome, contacto:document.getElementById('forn-contacto').value,
    email:document.getElementById('forn-email').value,
    telefone:document.getElementById('forn-tel').value,
    endereco:document.getElementById('forn-end').value,
  };
  if (editingId) { db.update('fornecedores',editingId,data); toast('success','Fornecedor actualizado'); }
  else { db.insert('fornecedores',data); toast('success','Fornecedor cadastrado'); }
  setLoading(btn,false);
  closeModal('modal-forn');
  renderFornecedores();
}

async function deleteFornecedor(id) {
  const f = db.getById('fornecedores',id);
  const ok = await confirm('Eliminar Fornecedor',`Deseja eliminar "${f?.nome}"?`);
  if (ok) { db.remove('fornecedores',id); toast('success','Fornecedor eliminado'); renderFornecedores(); }
}

// ===================== PRATELEIRAS PAGE =====================
function renderPrateleiras() {
  const prateleiras = db.getAll('prateleiras');
  document.getElementById('page-prateleiras').innerHTML = `
    <div class="page-header">
      <div>
        <div class="page-title">${ICONS.shelf} Prateleiras</div>
        <div class="page-title-sub">Gerir localização e organização do depósito</div>
      </div>
      <div class="page-actions">
        <button class="btn btn-primary" onclick="openPrateleiraModal()">${ICONS.plus}<span class="btn-text-content">Nova Prateleira</span></button>
      </div>
    </div>
    <div class="table-wrap">
      <div class="table-header">
        <div class="table-title">${ICONS.list} Prateleiras <span class="chip">${prateleiras.length}</span></div>
      </div>
      <div class="tbl-scroll">
      <table>
        <thead><tr><th>Nome</th><th>Secção</th><th>Capacidade</th><th>Produtos</th><th>Ocupação</th><th>Acções</th></tr></thead>
        <tbody>
          ${prateleiras.length ? prateleiras.map(p=>{
            const count = db.getShelfCount(p.id);
            const pct = p.capacidade ? Math.min(100,Math.round((count/p.capacidade)*100)) : 0;
            return `<tr>
              <td class="td-name">${p.nome}</td>
              <td>${p.seccao||'—'}</td>
              <td>${p.capacidade||'—'}</td>
              <td class="font-bold text-accent">${count}</td>
              <td>
                <div style="display:flex;align-items:center;gap:8px;">
                  <div style="flex:1;height:6px;background:var(--border);border-radius:3px;">
                    <div style="height:6px;border-radius:3px;width:${pct}%;background:${pct>80?'var(--danger)':pct>50?'var(--warning)':'var(--accent)'};transition:width 0.4s;"></div>
                  </div>
                  <span style="font-size:11px;color:var(--text-muted);min-width:30px;">${pct}%</span>
                </div>
              </td>
              <td>
                <div style="display:flex;gap:5px;">
                  <button class="btn btn-secondary btn-icon" onclick="openPrateleiraModal(${p.id})">${ICONS.edit}</button>
                  <button class="btn btn-danger btn-icon" onclick="deletePrateleira(${p.id})">${ICONS.trash}</button>
                </div>
              </td>
            </tr>`;
          }).join('') : `<tr><td colspan="6"><div class="table-empty">${ICONS.shelf}<p>Nenhuma prateleira cadastrada</p></div></td></tr>`}
        </tbody>
      </table>
      </div>
    </div>

    <div class="modal-overlay" id="modal-prat">
      <div class="modal">
        <div class="modal-header">
          <div class="modal-title">${ICONS.shelf} <span id="modal-prat-title">Nova Prateleira</span></div>
          <button class="modal-close" onclick="closeModal('modal-prat')">${ICONS.x}</button>
        </div>
        <div class="modal-body">
          <div class="form-grid form-grid-2">
            <div class="field-wrap">
              <label class="field-label">Nome da Prateleira <span class="field-req">*</span></label>
              <input class="field-input" id="prat-nome" placeholder="Ex: Prateleira A1">
            </div>
            <div class="field-wrap">
              <label class="field-label">Secção</label>
              <input class="field-input" id="prat-seccao" placeholder="Ex: Secção A">
            </div>
            <div class="field-wrap">
              <label class="field-label">Capacidade (produtos)</label>
              <input class="field-input" id="prat-cap" type="number" min="1" placeholder="Ex: 100">
            </div>
          </div>
        </div>
        <div class="modal-footer">
          <button class="btn btn-secondary" onclick="closeModal('modal-prat')">Cancelar</button>
          <button class="btn btn-primary" id="btn-save-prat" onclick="savePrateleira()">
            <span class="btn-spin"></span><span class="btn-text-content">${ICONS.check} Guardar</span>
          </button>
        </div>
      </div>
    </div>
  `;
}

function openPrateleiraModal(id=null) {
  editingId = id;
  document.getElementById('modal-prat-title').textContent = id?'Editar Prateleira':'Nova Prateleira';
  if (id) {
    const p = db.getById('prateleiras',id);
    if (p) {
      document.getElementById('prat-nome').value=p.nome||'';
      document.getElementById('prat-seccao').value=p.seccao||'';
      document.getElementById('prat-cap').value=p.capacidade||'';
    }
  } else {
    ['prat-nome','prat-seccao','prat-cap'].forEach(i=>document.getElementById(i).value='');
  }
  document.getElementById('modal-prat').classList.add('open');
}

async function savePrateleira() {
  const nome = document.getElementById('prat-nome').value.trim();
  if (!nome) { toast('error','Nome obrigatório'); return; }
  const btn = document.getElementById('btn-save-prat');
  setLoading(btn,true);
  await new Promise(r=>setTimeout(r,400));
  const data = { nome, seccao:document.getElementById('prat-seccao').value, capacidade:parseInt(document.getElementById('prat-cap').value)||null };
  if (editingId) { db.update('prateleiras',editingId,data); toast('success','Prateleira actualizada'); }
  else { db.insert('prateleiras',data); toast('success','Prateleira cadastrada'); }
  setLoading(btn,false); closeModal('modal-prat'); renderPrateleiras();
}

async function deletePrateleira(id) {
  const p = db.getById('prateleiras',id);
  const ok = await confirm('Eliminar Prateleira',`Deseja eliminar "${p?.nome}"?`);
  if (ok) { db.remove('prateleiras',id); toast('success','Prateleira eliminada'); renderPrateleiras(); }
}

// ===================== LOTES PAGE =====================
let loteSearch='', loteFilter='todos';
function renderLotes() {
  const produtos = db.getAll('produtos');
  const fornecedores = db.getAll('fornecedores');
  let lotes = db.getAll('lotes');
  if (loteSearch) lotes = lotes.filter(l => l.numero_lote.toLowerCase().includes(loteSearch.toLowerCase()) || (db.getById('produtos',l.produto_id)?.nome||'').toLowerCase().includes(loteSearch.toLowerCase()));
  if (loteFilter==='ativos') lotes = lotes.filter(l=>daysUntil(l.validade)>=0);
  if (loteFilter==='avencer') lotes = lotes.filter(l=>{ const d=daysUntil(l.validade); return d>=0&&d<=90; });
  if (loteFilter==='vencidos') lotes = lotes.filter(l=>daysUntil(l.validade)<0);

  document.getElementById('page-lotes').innerHTML = `
    <div class="page-header">
      <div>
        <div class="page-title">${ICONS.lot} Cadastro de Lotes</div>
        <div class="page-title-sub">Gerir lotes e validades de medicamentos</div>
      </div>
      <div class="page-actions">
        <button class="btn btn-primary" onclick="openLoteModal()">${ICONS.plus}<span class="btn-text-content">Novo Lote</span></button>
      </div>
    </div>
    <div class="table-wrap">
      <div class="table-header">
        <div class="table-title">${ICONS.list} Lotes <span class="chip">${lotes.length}</span></div>
        <div class="table-actions">
          <div class="search-wrap">
            <span class="search-icon">${ICONS.search}</span>
            <input class="search-input" placeholder="Pesquisar lote..." value="${loteSearch}" oninput="loteSearch=this.value;renderLotes()">
          </div>
          <select class="select-filter" onchange="loteFilter=this.value;renderLotes()">
            <option value="todos" ${loteFilter==='todos'?'selected':''}>Todos</option>
            <option value="ativos" ${loteFilter==='ativos'?'selected':''}>Activos</option>
            <option value="avencer" ${loteFilter==='avencer'?'selected':''}>A Vencer</option>
            <option value="vencidos" ${loteFilter==='vencidos'?'selected':''}>Vencidos</option>
          </select>
        </div>
      </div>
      <div class="tbl-scroll">
      <table>
        <thead><tr><th>Nº Lote</th><th>Produto</th><th>Fornecedor</th><th>Quantidade</th><th>Validade</th><th>Dias Rest.</th><th>Código Barras</th><th>Status</th><th>Acções</th></tr></thead>
        <tbody>
          ${lotes.length ? lotes.map(l=>{
            const prod=db.getById('produtos',l.produto_id);
            const forn=db.getById('fornecedores',l.fornecedor_id);
            const st=getLotStatus(l.validade);
            const dias=daysUntil(l.validade);
            return `<tr>
              <td class="font-mono text-accent">${l.numero_lote}</td>
              <td class="td-name">${prod?prod.nome:'—'}</td>
              <td>${forn?forn.nome:'—'}</td>
              <td class="font-bold">${l.quantidade||0}</td>
              <td>${formatDate(l.validade)}</td>
              <td class="${dias<0?'text-danger':dias<=90?'text-warning':'text-accent'}">${dias<0?`Há ${Math.abs(dias)}d`:dias===Infinity?'—':`${dias}d`}</td>
              <td class="font-mono text-muted">${l.codigo_barra||'—'}</td>
              <td><span class="badge ${st.cls}">${st.label}</span></td>
              <td>
                <div style="display:flex;gap:5px;">
                  <button class="btn btn-secondary btn-icon" onclick="openLoteModal(${l.id})">${ICONS.edit}</button>
                  <button class="btn btn-danger btn-icon" onclick="deleteLote(${l.id})">${ICONS.trash}</button>
                </div>
              </td>
            </tr>`;
          }).join('') : `<tr><td colspan="9"><div class="table-empty">${ICONS.lot}<p>Nenhum lote encontrado</p></div></td></tr>`}
        </tbody>
      </table>
      </div>
    </div>

    <div class="modal-overlay" id="modal-lote">
      <div class="modal">
        <div class="modal-header">
          <div class="modal-title">${ICONS.lot} <span id="modal-lote-title">Novo Lote</span></div>
          <button class="modal-close" onclick="closeModal('modal-lote')">${ICONS.x}</button>
        </div>
        <div class="modal-body">
          <div class="form-grid form-grid-2">
            <div class="field-wrap">
              <label class="field-label">${ICONS.barcode} Número do Lote <span class="field-req">*</span></label>
              <input class="field-input" id="lote-numero" placeholder="Ex: LOT-2025-001">
            </div>
            <div class="field-wrap">
              <label class="field-label">${ICONS.pill} Produto <span class="field-req">*</span></label>
              <select class="field-select" id="lote-produto">
                <option value="">Seleccionar produto...</option>
                ${produtos.map(p=>`<option value="${p.id}">${p.nome}</option>`).join('')}
              </select>
            </div>
            <div class="field-wrap">
              <label class="field-label">${ICONS.supplier} Fornecedor</label>
              <select class="field-select" id="lote-fornecedor">
                <option value="">Seleccionar fornecedor...</option>
                ${fornecedores.map(f=>`<option value="${f.id}">${f.nome}</option>`).join('')}
              </select>
            </div>
            <div class="field-wrap">
              <label class="field-label">${ICONS.package} Quantidade</label>
              <input class="field-input" id="lote-quantidade" type="number" min="1" placeholder="Ex: 200">
            </div>
            <div class="field-wrap">
              <label class="field-label">${ICONS.calendar} Validade</label>
              <input class="field-input" id="lote-validade" type="date">
            </div>
            <div class="field-wrap">
              <label class="field-label">${ICONS.barcode} Código de Barras</label>
              <input class="field-input" id="lote-barcode" placeholder="Ex: 7891234567890">
            </div>
          </div>
        </div>
        <div class="modal-footer">
          <button class="btn btn-secondary" onclick="closeModal('modal-lote')">Cancelar</button>
          <button class="btn btn-primary" id="btn-save-lote" onclick="saveLote()">
            <span class="btn-spin"></span><span class="btn-text-content">${ICONS.check} Guardar</span>
          </button>
        </div>
      </div>
    </div>
  `;
}

function openLoteModal(id=null) {
  editingId=id;
  document.getElementById('modal-lote-title').textContent=id?'Editar Lote':'Novo Lote';
  if (id) {
    const l=db.getById('lotes',id);
    if(l){
      document.getElementById('lote-numero').value=l.numero_lote||'';
      document.getElementById('lote-produto').value=l.produto_id||'';
      document.getElementById('lote-fornecedor').value=l.fornecedor_id||'';
      document.getElementById('lote-quantidade').value=l.quantidade||'';
      document.getElementById('lote-validade').value=l.validade||'';
      document.getElementById('lote-barcode').value=l.codigo_barra||'';
    }
  } else {
    ['lote-numero','lote-quantidade','lote-validade','lote-barcode'].forEach(i=>document.getElementById(i).value='');
    document.getElementById('lote-produto').value='';
    document.getElementById('lote-fornecedor').value='';
  }
  document.getElementById('modal-lote').classList.add('open');
}

async function saveLote() {
  const numero=document.getElementById('lote-numero').value.trim();
  const prodId=parseInt(document.getElementById('lote-produto').value);
  if(!numero){toast('error','Número do lote obrigatório');return;}
  if(!prodId){toast('error','Produto obrigatório');return;}
  const btn=document.getElementById('btn-save-lote');
  setLoading(btn,true);
  await new Promise(r=>setTimeout(r,400));
  const data={
    numero_lote:numero, produto_id:prodId,
    fornecedor_id:parseInt(document.getElementById('lote-fornecedor').value)||null,
    quantidade:parseInt(document.getElementById('lote-quantidade').value)||0,
    validade:document.getElementById('lote-validade').value,
    codigo_barra:document.getElementById('lote-barcode').value,
  };
  if(editingId){db.update('lotes',editingId,data);toast('success','Lote actualizado');}
  else{db.insert('lotes',data);toast('success','Lote cadastrado');}
  setLoading(btn,false); closeModal('modal-lote'); renderLotes(); updateAlertBadge();
}

async function deleteLote(id) {
  const l=db.getById('lotes',id);
  const ok=await confirm('Eliminar Lote',`Deseja eliminar o lote "${l?.numero_lote}"?`);
  if(ok){db.remove('lotes',id);toast('success','Lote eliminado');renderLotes();updateAlertBadge();}
}

// ===================== MOVIMENTACOES PAGE =====================
let movSearch='', movFilter='todos', movDateFrom='', movDateTo='';

function renderMovimentacoes() {
  const produtos = db.getAll('produtos');
  const lotes = db.getAll('lotes');
  let movs = db.getAll('movimentacoes');

  // Filters
  if (movSearch) movs = movs.filter(m=>(db.getById('produtos',m.produto_id)?.nome||'').toLowerCase().includes(movSearch.toLowerCase())||(m.destino||'').toLowerCase().includes(movSearch.toLowerCase()));
  if (movFilter!=='todos') movs = movs.filter(m=>m.tipo===movFilter);
  if (movDateFrom) movs = movs.filter(m=>m.data >= movDateFrom);
  if (movDateTo) movs = movs.filter(m=>m.data <= movDateTo);

  const sortedMovs = [...movs].sort((a,b)=>new Date(b.data)-new Date(a.data));

  document.getElementById('page-movimentacoes').innerHTML = `
    <div class="page-header">
      <div>
        <div class="page-title">${ICONS.movement} Entradas / Saídas</div>
        <div class="page-title-sub">Registar e consultar movimentações de stock</div>
      </div>
      <div class="page-actions">
        <button class="btn btn-primary" onclick="openMovModal()">${ICONS.plus}<span class="btn-text-content">Nova Movimentação</span></button>
      </div>
    </div>
    <div class="table-wrap">
      <div class="table-header">
        <div class="table-title">${ICONS.list} Movimentações <span class="chip">${sortedMovs.length}</span></div>
        <div class="table-actions" style="flex-wrap:wrap;gap:8px;">
          <div class="search-wrap">
            <span class="search-icon">${ICONS.search}</span>
            <input class="search-input" placeholder="Pesquisar produto/destino..." value="${movSearch}" oninput="movSearch=this.value;renderMovimentacoes()">
          </div>
          <select class="select-filter" onchange="movFilter=this.value;renderMovimentacoes()">
            <option value="todos" ${movFilter==='todos'?'selected':''}>Todos os tipos</option>
            <option value="Entrada" ${movFilter==='Entrada'?'selected':''}>Entradas</option>
            <option value="Saída" ${movFilter==='Saída'?'selected':''}>Saídas</option>
          </select>
          <div class="date-filter-wrap">
            ${ICONS.calendar}
            <input type="date" value="${movDateFrom}" onchange="movDateFrom=this.value;renderMovimentacoes()" title="Data de início">
            <span>—</span>
            <input type="date" value="${movDateTo}" onchange="movDateTo=this.value;renderMovimentacoes()" title="Data de fim">
          </div>
          ${(movDateFrom||movDateTo) ? `<button class="btn btn-secondary" onclick="movDateFrom='';movDateTo='';renderMovimentacoes()" style="padding:6px 10px;font-size:11px;">${ICONS.x} Limpar datas</button>` : ''}
        </div>
      </div>
      <div class="tbl-scroll">
      <table>
        <thead><tr>
          <th>Produto</th><th>Tipo</th><th>Lote</th><th>Quantidade</th><th>Destino/Origem</th><th>Preço Unit.</th><th>Data</th><th>Acções</th>
        </tr></thead>
        <tbody>
          ${sortedMovs.length ? sortedMovs.map(m=>{
            const prod=db.getById('produtos',m.produto_id);
            const lot=db.getById('lotes',m.lote_id);
            return `<tr>
              <td class="td-name">${prod?prod.nome:'—'}</td>
              <td><span class="badge ${m.tipo==='Entrada'?'badge-success':'badge-danger'}">${m.tipo==='Entrada'?ICONS.arrow_up:ICONS.arrow_down} ${m.tipo}</span></td>
              <td class="font-mono text-muted">${lot?lot.numero_lote:'—'}</td>
              <td class="font-bold ${m.tipo==='Entrada'?'text-accent':'text-danger'}">${m.quantidade}</td>
              <td>${m.destino||'—'}</td>
              <td>${m.preco?formatMoney(m.preco):'—'}</td>
              <td>${formatDate(m.data)}</td>
              <td>
                <div style="display:flex;gap:5px;">
                  <button class="btn btn-secondary btn-icon" onclick="openMovModal(${m.id})">${ICONS.edit}</button>
                  <button class="btn btn-danger btn-icon" onclick="deleteMov(${m.id})">${ICONS.trash}</button>
                </div>
              </td>
            </tr>`;
          }).join('') : `<tr><td colspan="8"><div class="table-empty">${ICONS.movement}<p>Nenhuma movimentação encontrada</p></div></td></tr>`}
        </tbody>
      </table>
      </div>
    </div>

    <div class="modal-overlay" id="modal-mov">
      <div class="modal">
        <div class="modal-header">
          <div class="modal-title">${ICONS.movement} <span id="modal-mov-title">Nova Movimentação</span></div>
          <button class="modal-close" onclick="closeModal('modal-mov')">${ICONS.x}</button>
        </div>
        <div class="modal-body">
          <div class="form-grid form-grid-2">
            <div class="field-wrap">
              <label class="field-label">${ICONS.pill} Produto <span class="field-req">*</span></label>
              <select class="field-select" id="mov-produto" onchange="updateMovLotes()">
                <option value="">Seleccionar produto...</option>
                ${produtos.map(p=>`<option value="${p.id}">${p.nome}</option>`).join('')}
              </select>
            </div>
            <div class="field-wrap">
              <label class="field-label">${ICONS.movement} Tipo <span class="field-req">*</span></label>
              <select class="field-select" id="mov-tipo">
                <option value="Entrada">Entrada</option>
                <option value="Saída">Saída</option>
              </select>
            </div>
            <div class="field-wrap">
              <label class="field-label">${ICONS.lot} Lote</label>
              <select class="field-select" id="mov-lote">
                <option value="">Seleccionar lote...</option>
              </select>
            </div>
            <div class="field-wrap">
              <label class="field-label">${ICONS.package} Quantidade <span class="field-req">*</span></label>
              <input class="field-input" id="mov-quantidade" type="number" min="1" placeholder="Ex: 50">
            </div>
            <div class="field-wrap">
              <label class="field-label">${ICONS.map_pin} Destino/Origem</label>
              <input class="field-input" id="mov-destino" placeholder="Ex: Enfermaria A">
            </div>
            <div class="field-wrap">
              <label class="field-label">${ICONS.calendar} Data</label>
              <input class="field-input" id="mov-data" type="date" value="${today()}">
            </div>
            <div class="field-wrap form-grid-full">
              <label class="field-label">${ICONS.money} Preço Unitário (AOA)</label>
              <input class="field-input" id="mov-preco" type="number" min="0" step="0.01" placeholder="Opcional">
            </div>
          </div>
        </div>
        <div class="modal-footer">
          <button class="btn btn-secondary" onclick="closeModal('modal-mov')">Cancelar</button>
          <button class="btn btn-primary" id="btn-save-mov" onclick="saveMov()">
            <span class="btn-spin"></span><span class="btn-text-content">${ICONS.check} Registar</span>
          </button>
        </div>
      </div>
    </div>
  `;
}

function updateMovLotes() {
  const prodId = parseInt(document.getElementById('mov-produto').value);
  const loteSelect = document.getElementById('mov-lote');
  if (!loteSelect) return;
  const prodLotes = db.getAll('lotes').filter(l=>l.produto_id===prodId).sort((a,b)=>new Date(a.validade)-new Date(b.validade));
  loteSelect.innerHTML = `<option value="">Seleccionar lote...</option>` +
    prodLotes.map(l=>{
      const st=getLotStatus(l.validade);
      return `<option value="${l.id}">${l.numero_lote} — Val: ${formatDate(l.validade)} (${st.label})</option>`;
    }).join('');
}

function openMovModal(id=null) {
  editingId=id;
  document.getElementById('modal-mov-title').textContent=id?'Editar Movimentação':'Nova Movimentação';
  if(id){
    const m=db.getById('movimentacoes',id);
    if(m){
      document.getElementById('mov-produto').value=m.produto_id||'';
      updateMovLotes();
      document.getElementById('mov-tipo').value=m.tipo||'Entrada';
      document.getElementById('mov-lote').value=m.lote_id||'';
      document.getElementById('mov-quantidade').value=m.quantidade||'';
      document.getElementById('mov-destino').value=m.destino||'';
      document.getElementById('mov-data').value=m.data||today();
      document.getElementById('mov-preco').value=m.preco||'';
    }
  } else {
    document.getElementById('mov-produto').value='';
    document.getElementById('mov-tipo').value='Entrada';
    document.getElementById('mov-lote').value='';
    document.getElementById('mov-quantidade').value='';
    document.getElementById('mov-destino').value='';
    document.getElementById('mov-data').value=today();
    document.getElementById('mov-preco').value='';
  }
  document.getElementById('modal-mov').classList.add('open');
}

async function saveMov() {
  const prodId=parseInt(document.getElementById('mov-produto').value);
  const tipo=document.getElementById('mov-tipo').value;
  const qtd=parseInt(document.getElementById('mov-quantidade').value);
  if(!prodId){toast('error','Produto obrigatório');return;}
  if(!qtd||qtd<1){toast('error','Quantidade inválida');return;}
  if(tipo==='Saída'){
    const {stock}=db.getStock(prodId);
    const prod=db.getById('produtos',prodId);
    if(stock-qtd<0){toast('error','Stock insuficiente',`Stock actual: ${stock}. Saída bloqueada.`);return;}
  }
  const btn=document.getElementById('btn-save-mov');
  setLoading(btn,true);
  await new Promise(r=>setTimeout(r,400));
  const data={
    produto_id:prodId, tipo,
    lote_id:parseInt(document.getElementById('mov-lote').value)||null,
    quantidade:qtd,
    destino:document.getElementById('mov-destino').value,
    data:document.getElementById('mov-data').value||today(),
    preco:parseFloat(document.getElementById('mov-preco').value)||null,
  };
  if(editingId){db.update('movimentacoes',editingId,data);toast('success','Movimentação actualizada');}
  else{db.insert('movimentacoes',data);toast('success',`${tipo} registada com sucesso`);}
  setLoading(btn,false); closeModal('modal-mov'); renderMovimentacoes(); updateAlertBadge();
}

async function deleteMov(id) {
  const ok=await confirm('Eliminar Movimentação','Deseja eliminar esta movimentação?');
  if(ok){db.remove('movimentacoes',id);toast('success','Movimentação eliminada');renderMovimentacoes();updateAlertBadge();}
}

// ===================== ALERTAS PAGE =====================
function renderAlertas() {
  const alerts = getAlerts();
  document.getElementById('page-alertas').innerHTML = `
    <div class="page-header">
      <div>
        <div class="page-title">${ICONS.alert} Alertas do Sistema</div>
        <div class="page-title-sub">Notificações e avisos importantes</div>
      </div>
      <button class="btn btn-secondary" onclick="renderAlertas()">${ICONS.refresh} Actualizar</button>
    </div>
    <div class="grid-2" style="gap:20px;margin-bottom:20px;">
      ${[
        ['Lotes Vencidos',alerts.filter(a=>a.type==='err').length,'err'],
        ['A Vencer (90d)',alerts.filter(a=>a.title.includes('vencer')).length,'warn'],
        ['Stock Mínimo',alerts.filter(a=>a.title.includes('Stock')).length,'warn'],
        ['Total Alertas',alerts.length,alerts.length>0?'err':'ok'],
      ].map(([l,v,t])=>`
        <div class="card" style="display:flex;align-items:center;gap:16px;">
          <div class="alert-icon ${t}">${ICONS[t==='err'?'alert':t==='warn'?'clock':t==='ok'?'check':'info']}</div>
          <div>
            <div style="font-size:24px;font-weight:700;color:var(--text-primary)">${v}</div>
            <div style="font-size:12px;color:var(--text-muted)">${l}</div>
          </div>
        </div>
      `).join('')}
    </div>
    <div class="table-wrap">
      <div class="table-header">
        <div class="table-title">${ICONS.bell} Todas as Notificações <span class="chip">${alerts.length}</span></div>
      </div>
      ${alerts.length ? alerts.map(a=>`
        <div class="alert-item">
          <div class="alert-icon ${a.type}">${ICONS[a.icon]||ICONS.alert}</div>
          <div class="alert-content">
            <div class="alert-title">${a.title}</div>
            <div class="alert-desc">${a.desc}</div>
          </div>
          <div class="alert-time">${a.time}</div>
        </div>
      `).join('') : `<div class="table-empty" style="padding:48px;">${ICONS.check}<p style="color:var(--success)">Sistema sem alertas activos</p></div>`}
    </div>
  `;
}

// ===================== RELATORIOS PAGE (XLSX ONLY) =====================
function renderRelatorios() {
  document.getElementById('page-relatorios').innerHTML = `
    <div class="page-header">
      <div>
        <div class="page-title">${ICONS.report} Relatórios</div>
        <div class="page-title-sub">Exportar dados do sistema em formato <strong>.XLSX</strong> (Excel)</div>
      </div>
    </div>
    <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(240px,1fr));gap:16px;">
      ${[
        ['Produtos','pill','Lista completa de medicamentos com stocks','produtos'],
        ['Fornecedores','supplier','Lista de fornecedores cadastrados','fornecedores'],
        ['Prateleiras','shelf','Localização e ocupação das prateleiras','prateleiras'],
        ['Lotes','lot','Lotes com validades e estados','lotes'],
        ['Movimentações','movement','Histórico de entradas e saídas','movimentacoes'],
        ['Alertas','alert','Relatório de alertas activos','alertas'],
        ['Stock Actual','package','Snapshot do stock por produto','stock'],
        ['Relatório Geral','report','Todos os dados em múltiplas folhas XLSX','geral'],
      ].map(([title,ico,desc,key])=>`
        <div class="report-card">
          <div class="report-card-icon">${ICONS[ico]||''}</div>
          <div class="report-card-title">${title}</div>
          <div class="report-card-desc">${desc}</div>
          <div style="display:flex;gap:6px;margin-top:10px;align-items:center;font-size:10px;color:var(--text-muted);">
            ${ICONS.download} Formato: <strong style="color:var(--accent);">.XLSX</strong>
          </div>
          <button class="btn btn-primary" style="margin-top:10px;width:100%;" onclick="exportReportXLSX('${key}')">
            ${ICONS.download}<span class="btn-text-content">Exportar XLSX</span>
          </button>
        </div>
      `).join('')}
    </div>
  `;
}

function exportReportXLSX(key) {
  toast('info','A gerar relatório XLSX...','Por favor aguarde');
  setTimeout(() => {
    try {
      let sheets, filename;

      if (key === 'produtos') {
        sheets = [{ name: 'Produtos', data: db.getAll('produtos').map(p => {
          const {entradas,saidas,stock} = db.getStock(p.id);
          const prat = db.getById('prateleiras',p.prateleira_id);
          return {'ID':p.id,'Nome':p.nome,'Forma Farmacêutica':p.forma||'','Grupo Farmacológico':p.grupo_farmacologico||'','Prateleira':prat?prat.nome:'','Stock Mínimo':p.stock_minimo||0,'Preco AOA':p.preco||0,'Entradas':entradas,'Saidas':saidas,'Stock Actual':stock,'Status':p.stock_minimo&&stock<=p.stock_minimo?'Stock Baixo':'Normal'};
        })}];
        filename = `relatorio_produtos_${today()}.xlsx`;
      } else if (key === 'fornecedores') {
        sheets = [{ name: 'Fornecedores', data: db.getAll('fornecedores').map(f=>({'ID':f.id,'Nome':f.nome,'Contacto':f.contacto||'','Email':f.email||'','Telefone':f.telefone||'','Endereco':f.endereco||''})) }];
        filename = `relatorio_fornecedores_${today()}.xlsx`;
      } else if (key === 'prateleiras') {
        sheets = [{ name: 'Prateleiras', data: db.getAll('prateleiras').map(p=>({'ID':p.id,'Nome':p.nome,'Seccao':p.seccao||'','Capacidade':p.capacidade||0,'N Produtos':db.getShelfCount(p.id)})) }];
        filename = `relatorio_prateleiras_${today()}.xlsx`;
      } else if (key === 'lotes') {
        sheets = [{ name: 'Lotes', data: db.getAll('lotes').map(l=>{
          const p=db.getById('produtos',l.produto_id), f=db.getById('fornecedores',l.fornecedor_id), st=getLotStatus(l.validade);
          return {'ID':l.id,'N Lote':l.numero_lote,'Produto':p?p.nome:'','Fornecedor':f?f.nome:'','Quantidade':l.quantidade||0,'Validade':l.validade,'Cod Barras':l.codigo_barra||'','Status':st.label,'Dias Restantes':daysUntil(l.validade)};
        })}];
        filename = `relatorio_lotes_${today()}.xlsx`;
      } else if (key === 'movimentacoes') {
        const rows = db.getAll('movimentacoes').map(m=>{
          const p=db.getById('produtos',m.produto_id), l=db.getById('lotes',m.lote_id);
          return {'ID':m.id,'Produto':p?p.nome:'','Tipo':m.tipo,'Lote':l?l.numero_lote:'','Quantidade':m.quantidade,'Destino Origem':m.destino||'','Preco Unit AOA':m.preco||0,'Data':m.data};
        }).sort((a,b)=>new Date(b.Data)-new Date(a.Data));
        sheets = [{ name: 'Movimentacoes', data: rows }];
        filename = `relatorio_movimentacoes_${today()}.xlsx`;
      } else if (key === 'stock') {
        sheets = [{ name: 'Stock Actual', data: db.getAll('produtos').map(p=>{
          const {entradas,saidas,stock}=db.getStock(p.id), prat=db.getById('prateleiras',p.prateleira_id);
          return {'ID':p.id,'Produto':p.nome,'Grupo':p.grupo_farmacologico||'','Prateleira':prat?prat.nome:'','Stock Minimo':p.stock_minimo||0,'Entradas':entradas,'Saidas':saidas,'Stock Actual':stock,'Status':p.stock_minimo&&stock<=p.stock_minimo?'STOCK BAIXO':'Normal'};
        })}];
        filename = `relatorio_stock_${today()}.xlsx`;
      } else if (key === 'alertas') {
        const rows = getAlerts().map(a=>({'Tipo':a.type==='err'?'Critico':'Aviso','Titulo':a.title,'Descricao':a.desc,'Data Hora':a.time}));
        sheets = [{ name: 'Alertas', data: rows.length ? rows : [{'Mensagem':'Sem alertas activos'}] }];
        filename = `relatorio_alertas_${today()}.xlsx`;
      } else {
        // Relatório Geral — múltiplas abas
        const prodRows = db.getAll('produtos').map(p=>{
          const {entradas,saidas,stock}=db.getStock(p.id), prat=db.getById('prateleiras',p.prateleira_id);
          return {'Nome':p.nome,'Forma':p.forma||'','Grupo':p.grupo_farmacologico||'','Prateleira':prat?prat.nome:'','Stock Min':p.stock_minimo||0,'Entradas':entradas,'Saidas':saidas,'Stock Actual':stock};
        });
        const movRows = db.getAll('movimentacoes').map(m=>{
          const p=db.getById('produtos',m.produto_id), l=db.getById('lotes',m.lote_id);
          return {'Produto':p?p.nome:'','Tipo':m.tipo,'Lote':l?l.numero_lote:'','Qtd':m.quantidade,'Destino':m.destino||'','Data':m.data};
        });
        const loteRows = db.getAll('lotes').map(l=>{
          const p=db.getById('produtos',l.produto_id), st=getLotStatus(l.validade);
          return {'N Lote':l.numero_lote,'Produto':p?p.nome:'','Qtd':l.quantidade,'Validade':l.validade,'Status':st.label};
        });
        const alertRows = getAlerts().map(a=>({'Tipo':a.type==='err'?'Critico':'Aviso','Titulo':a.title,'Descricao':a.desc}));
        sheets = [
          { name: 'Produtos',       data: prodRows.length  ? prodRows  : [{'info':'Sem dados'}] },
          { name: 'Movimentacoes',  data: movRows.length   ? movRows   : [{'info':'Sem dados'}] },
          { name: 'Lotes',          data: loteRows.length  ? loteRows  : [{'info':'Sem dados'}] },
          { name: 'Alertas',        data: alertRows.length ? alertRows : [{'Mensagem':'Sem alertas'}] }
        ];
        filename = `relatorio_geral_HMM_${today()}.xlsx`;
      }

      if (XLSXio.download(sheets, filename)) {
        toast('success','Relatório XLSX exportado','Ficheiro Excel gerado com sucesso');
      }
    } catch(e) {
      toast('error','Erro ao exportar',e.message);
    }
  }, 300);
}

// ===================== BASE DE DADOS PAGE (XLSX) =====================
function renderBaseDados() {
  const totals = {
    produtos: db.getAll('produtos').length,
    fornecedores: db.getAll('fornecedores').length,
    prateleiras: db.getAll('prateleiras').length,
    lotes: db.getAll('lotes').length,
    movimentacoes: db.getAll('movimentacoes').length,
  };
  document.getElementById('page-basedados').innerHTML = `
    <div class="page-header">
      <div>
        <div class="page-title">${ICONS.database} Base de Dados</div>
        <div class="page-title-sub">Gestão e manutenção da base de dados do sistema</div>
      </div>
    </div>
    <div class="grid-2" style="gap:20px;">
      <div>
        <div class="card" style="margin-bottom:20px;">
          <div class="card-header"><div class="card-title">${ICONS.info} Informações da Base de Dados</div></div>
          <div class="db-stats-grid">
            ${Object.entries(totals).map(([k,v])=>`
              <div class="db-stat">
                <div class="db-stat-val">${v}</div>
                <div class="db-stat-lbl">${k.charAt(0).toUpperCase()+k.slice(1)}</div>
              </div>
            `).join('')}
            <div class="db-stat">
              <div class="db-stat-val" style="font-size:13px;">localStorage</div>
              <div class="db-stat-lbl">Armazenamento</div>
            </div>
          </div>
          <div style="font-size:12px;color:var(--text-muted);margin-top:8px;">
            ${ICONS.info} Base de dados armazenada localmente no browser. Última actualização: ${new Date().toLocaleString('pt-AO')}.
          </div>
        </div>

        <div class="card">
          <div class="card-header"><div class="card-title">${ICONS.download} Exportar / Importar (formato .XLSX)</div></div>
          <div class="db-action-grid">
            <button class="db-action-btn" onclick="exportDBXLSX()">
              <div class="db-action-icon" style="background:rgba(0,184,148,0.1);color:var(--accent);">${ICONS.download}</div>
              <div class="db-action-title">Exportar Base de Dados</div>
              <div class="db-action-desc">Guardar todos os dados em ficheiro .XLSX</div>
            </button>
            <label class="db-action-btn" style="cursor:pointer;">
              <div class="db-action-icon" style="background:rgba(52,152,219,0.1);color:var(--info);">${ICONS.upload}</div>
              <div class="db-action-title">Importar Base de Dados</div>
              <div class="db-action-desc">Carregar dados de um ficheiro .XLSX</div>
              <input type="file" accept=".xlsx,.xls" style="display:none;" onchange="importDBXLSX(event)">
            </label>
          </div>
        </div>
      </div>

      <div>
        <div class="card">
          <div class="card-header"><div class="card-title">${ICONS.settings} Manutenção</div></div>
          <div class="db-action-grid">
            <button class="db-action-btn danger" onclick="clearDB()">
              <div class="db-action-icon" style="background:rgba(231,76,60,0.1);color:var(--danger);">${ICONS.trash}</div>
              <div class="db-action-title">Limpar Base de Dados</div>
              <div class="db-action-desc">Eliminar todos os dados (mantém utilizadores)</div>
            </button>
          </div>
        </div>

        <div class="card" style="margin-top:20px;">
          <div class="card-header"><div class="card-title">${ICONS.info} Estado do Sistema</div></div>
          <div style="display:flex;flex-direction:column;gap:10px;">
            ${[
              ['Sistema','Hospital Municipal de Malanje','ok'],
              ['Versão','v2.0.0','info'],
              ['Modo','Offline/Online','ok'],
              ['Segurança','SHA-256 Passwords','ok'],
              ['Exportação','Exclusivamente .XLSX','info'],
              ['Utilizador',currentUser?.nome||'—','info'],
              ['Função',currentUser?.funcao||'—','info'],
              ['Sessão',new Date().toLocaleString('pt-AO'),'info'],
            ].map(([l,v,t])=>`
              <div style="display:flex;justify-content:space-between;padding:8px 0;border-bottom:1px solid var(--border);font-size:13px;">
                <span style="color:var(--text-muted)">${l}</span>
                <span class="text-${t==='ok'?'accent':t==='info'?'secondary':'danger'}" style="font-weight:500;">${v}</span>
              </div>
            `).join('')}
          </div>
        </div>
      </div>
    </div>
  `;
}

function exportDBXLSX() {
  try {
    const tables = ['produtos','fornecedores','prateleiras','lotes','movimentacoes'];
    const sheets = tables.map(t => ({
      name: t.charAt(0).toUpperCase()+t.slice(1),
      data: db.getAll(t, true)
    }));
    sheets.push({ name: 'Meta', data: [{'Sistema':'HMM Deposito de Medicamentos','Versao':'2.0','Exportado em':new Date().toLocaleString('pt-AO'),'Utilizador':currentUser?.nome||'—'}] });
    if (XLSXio.download(sheets, `hmm_database_${today()}.xlsx`)) {
      toast('success','Base de dados exportada','Ficheiro .XLSX gerado com sucesso');
    }
  } catch(e) { toast('error','Erro ao exportar',e.message); }
}

function importDBXLSX(event) {
  const file = event.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = async (e) => {
    try {
      const sheets = XLSXio.read(e.target.result);
      const ok = await confirm('Importar Base de Dados','Importar irá substituir todos os dados actuais (exceto utilizadores). Continuar?');
      if (!ok) return;
      const tableMap = {
        'Produtos':'produtos','Fornecedores':'fornecedores',
        'Prateleiras':'prateleiras','Lotes':'lotes',
        'Movimentacoes':'movimentacoes','Movimentações':'movimentacoes'
      };
      let imported = 0;
      for (const [sheetName, data] of Object.entries(sheets)) {
        const key = tableMap[sheetName];
        if (key && data.length && !data[0].info) {
          db.data[key] = data;
          imported++;
        }
      }
      db.save();
      toast('success','Base de dados importada',`${imported} tabelas importadas com sucesso`);
      renderBaseDados();
      updateAlertBadge();
    } catch(err) {
      toast('error','Erro ao importar','Ficheiro XLSX invalido: '+err.message);
    }
  };
  reader.readAsArrayBuffer(file);
  event.target.value = '';
}

async function clearDB() {
  const ok = await confirm('Limpar Base de Dados','Todos os dados serão eliminados permanentemente (utilizadores mantidos). Esta acção não pode ser revertida!');
  if (ok) {
    db.clear();
    toast('success','Base de dados limpa');
    renderBaseDados();
    updateAlertBadge();
  }
}

// ===================== UTILIZADORES PAGE =====================
let userEditingId = null;

function renderUsuarios() {
  if (currentUser?.funcao !== 'Administrador') {
    document.getElementById('page-usuarios').innerHTML = `
      <div class="table-empty" style="padding:80px 0;">
        ${ICONS.shield}
        <p>Acesso Restrito</p>
        <p style="font-size:12px;color:var(--text-muted)">Apenas administradores podem gerir utilizadores.</p>
      </div>`;
    return;
  }

  const usuarios = db.getAll('usuarios');
  document.getElementById('page-usuarios').innerHTML = `
    <div class="page-header">
      <div>
        <div class="page-title">${ICONS.users} Gestão de Utilizadores</div>
        <div class="page-title-sub">Cadastrar e gerir contas de acesso ao sistema</div>
      </div>
      <div class="page-actions">
        <button class="btn btn-primary" onclick="openUserModal()">${ICONS.plus}<span class="btn-text-content">Novo Utilizador</span></button>
      </div>
    </div>

    <div style="margin-bottom:16px;">
      <div style="background:rgba(0,184,148,0.08);border:1px solid rgba(0,184,148,0.2);border-radius:var(--radius-sm);padding:12px 16px;font-size:12px;color:var(--text-secondary);display:flex;align-items:center;gap:10px;">
        ${ICONS.shield}
        <span>As senhas são armazenadas com encriptação <strong>SHA-256</strong>. Nunca são guardadas em texto simples no código fonte ou base de dados.</span>
      </div>
    </div>

    <div class="table-wrap">
      <div class="table-header">
        <div class="table-title">${ICONS.list} Utilizadores <span class="chip">${usuarios.length}</span></div>
      </div>
      <div style="padding:16px;">
        ${usuarios.length ? usuarios.map(u=>`
          <div class="user-card">
            <div class="user-card-avatar">${initials(u.nome)}</div>
            <div class="user-card-info">
              <div class="user-card-name">${u.nome} ${u.id===currentUser.id?'<span style="font-size:10px;color:var(--accent);">(você)</span>':''}</div>
              <div class="user-card-meta">
                @${u.username}
                <span class="role-badge ${u.funcao==='Administrador'?'role-admin':'role-user'}" style="margin-left:8px;">${u.funcao}</span>
              </div>
            </div>
            <div class="user-card-actions">
              <button class="btn btn-secondary btn-icon" title="Alterar senha" onclick="openChangePasswordModal(${u.id})">${ICONS.lock}</button>
              <button class="btn btn-secondary btn-icon" title="Editar" onclick="openUserModal(${u.id})">${ICONS.edit}</button>
              ${u.id !== currentUser.id ? `<button class="btn btn-danger btn-icon" title="Eliminar" onclick="deleteUser(${u.id})">${ICONS.trash}</button>` : ''}
            </div>
          </div>
        `).join('') : `<div class="table-empty">${ICONS.users}<p>Nenhum utilizador encontrado</p></div>`}
      </div>
    </div>

    <!-- Modal Novo/Editar Utilizador -->
    <div class="modal-overlay" id="modal-user">
      <div class="modal">
        <div class="modal-header">
          <div class="modal-title">${ICONS.user} <span id="modal-user-title">Novo Utilizador</span></div>
          <button class="modal-close" onclick="closeModal('modal-user')">${ICONS.x}</button>
        </div>
        <div class="modal-body">
          <div class="form-grid form-grid-2">
            <div class="field-wrap form-grid-full">
              <label class="field-label">Nome Completo <span class="field-req">*</span></label>
              <input class="field-input" id="user-nome" placeholder="Ex: Maria dos Santos">
            </div>
            <div class="field-wrap">
              <label class="field-label">Nome de Utilizador <span class="field-req">*</span></label>
              <input class="field-input" id="user-username" placeholder="Ex: maria.santos">
            </div>
            <div class="field-wrap">
              <label class="field-label">Função</label>
              <select class="field-select" id="user-funcao">
                <option value="Farmacêutico">Farmacêutico</option>
                <option value="Técnico">Técnico</option>
                <option value="Enfermeiro">Enfermeiro</option>
                <option value="Administrador">Administrador</option>
              </select>
            </div>
            <div class="field-wrap" id="user-pwd-wrap">
              <label class="field-label">Senha <span class="field-req">*</span></label>
              <input class="field-input" id="user-pwd" type="password" placeholder="Mínimo 6 caracteres">
            </div>
          </div>
          <div style="font-size:11px;color:var(--text-muted);margin-top:8px;">
            ${ICONS.shield} A senha será armazenada de forma segura com SHA-256.
          </div>
        </div>
        <div class="modal-footer">
          <button class="btn btn-secondary" onclick="closeModal('modal-user')">Cancelar</button>
          <button class="btn btn-primary" id="btn-save-user" onclick="saveUser()">
            <span class="btn-spin"></span><span class="btn-text-content">${ICONS.check} Guardar</span>
          </button>
        </div>
      </div>
    </div>

    <!-- Modal Alterar Senha -->
    <div class="modal-overlay" id="modal-change-pwd">
      <div class="modal">
        <div class="modal-header">
          <div class="modal-title">${ICONS.lock} Alterar Senha</div>
          <button class="modal-close" onclick="closeModal('modal-change-pwd')">${ICONS.x}</button>
        </div>
        <div class="modal-body">
          <div class="form-grid">
            <div class="field-wrap">
              <label class="field-label">Nova Senha <span class="field-req">*</span></label>
              <input class="field-input" id="new-pwd" type="password" placeholder="Mínimo 6 caracteres">
            </div>
            <div class="field-wrap">
              <label class="field-label">Confirmar Senha <span class="field-req">*</span></label>
              <input class="field-input" id="new-pwd2" type="password" placeholder="Repetir senha">
            </div>
          </div>
        </div>
        <div class="modal-footer">
          <button class="btn btn-secondary" onclick="closeModal('modal-change-pwd')">Cancelar</button>
          <button class="btn btn-primary" id="btn-save-pwd" onclick="saveNewPassword()">
            <span class="btn-spin"></span><span class="btn-text-content">${ICONS.check} Alterar Senha</span>
          </button>
        </div>
      </div>
    </div>
  `;
}

function openUserModal(id=null) {
  userEditingId = id;
  document.getElementById('modal-user-title').textContent = id?'Editar Utilizador':'Novo Utilizador';
  const pwdWrap = document.getElementById('user-pwd-wrap');
  if (id) {
    const u = db.getById('usuarios',id);
    if (u) {
      document.getElementById('user-nome').value=u.nome||'';
      document.getElementById('user-username').value=u.username||'';
      document.getElementById('user-funcao').value=u.funcao||'Farmacêutico';
    }
    if (pwdWrap) pwdWrap.style.display='none';
  } else {
    ['user-nome','user-username','user-pwd'].forEach(i=>{ const el=document.getElementById(i); if(el)el.value=''; });
    document.getElementById('user-funcao').value='Farmacêutico';
    if (pwdWrap) pwdWrap.style.display='';
  }
  document.getElementById('modal-user').classList.add('open');
}

function openChangePasswordModal(id) {
  userEditingId = id;
  document.getElementById('new-pwd').value='';
  document.getElementById('new-pwd2').value='';
  document.getElementById('modal-change-pwd').classList.add('open');
}

async function saveUser() {
  const nome = document.getElementById('user-nome').value.trim();
  const username = document.getElementById('user-username').value.trim();
  const funcao = document.getElementById('user-funcao').value;
  if (!nome||!username) { toast('error','Campos obrigatórios','Preencha nome e utilizador'); return; }

  const btn = document.getElementById('btn-save-user');
  setLoading(btn,true);

  if (userEditingId) {
    // Check username uniqueness
    const exists = db.data.usuarios.find(u=>u.username===username && u.id!==userEditingId);
    if (exists) { toast('error','Nome de utilizador já existe'); setLoading(btn,false); return; }
    db.update('usuarios', userEditingId, { nome, username, funcao });
    toast('success','Utilizador actualizado');
  } else {
    const exists = db.data.usuarios.find(u=>u.username===username);
    if (exists) { toast('error','Nome de utilizador já existe'); setLoading(btn,false); return; }
    const pwd = document.getElementById('user-pwd').value;
    if (pwd.length < 6) { toast('error','Senha muito curta','Mínimo 6 caracteres'); setLoading(btn,false); return; }
    const hashed = await hashPassword(pwd);
    db.insert('usuarios',{ username, senha:hashed, nome, funcao });
    toast('success','Utilizador criado com sucesso');
  }

  setLoading(btn,false);
  closeModal('modal-user');
  renderUsuarios();
}

async function saveNewPassword() {
  const pwd = document.getElementById('new-pwd').value;
  const pwd2 = document.getElementById('new-pwd2').value;
  if (pwd.length < 6) { toast('error','Senha muito curta','Mínimo 6 caracteres'); return; }
  if (pwd !== pwd2) { toast('error','Senhas não coincidem'); return; }
  const btn = document.getElementById('btn-save-pwd');
  setLoading(btn,true);
  const hashed = await hashPassword(pwd);
  db.update('usuarios', userEditingId, { senha: hashed });
  toast('success','Senha alterada com sucesso');
  setLoading(btn,false);
  closeModal('modal-change-pwd');
}

async function deleteUser(id) {
  const u = db.getById('usuarios',id);
  if (db.data.usuarios.filter(u=>u.ativo!==false).length <= 1) {
    toast('error','Operação inválida','Não pode eliminar o último utilizador activo.');
    return;
  }
  const ok = await confirm('Eliminar Utilizador',`Deseja eliminar "${u?.nome}"? Esta acção não pode ser revertida.`);
  if (ok) { db.remove('usuarios',id); toast('success','Utilizador eliminado'); renderUsuarios(); }
}

// ===================== SINCRONIZAÇÃO PAGE =====================
let syncConfig = JSON.parse(localStorage.getItem('hmm_sync_config')||'{"webAppUrl":"","sheetId":"","lastSync":"","status":"disconnected"}');

function saveSyncConfig() {
  localStorage.setItem('hmm_sync_config', JSON.stringify(syncConfig));
}

function renderSincronizacao() {
  const GAS_SCRIPT = `// Google Apps Script — Cole este código em Extensions > Apps Script
// Deploy como Web App (acesso: "Anyone")
function doPost(e) {
  const data = JSON.parse(e.postData.contents);
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const tables = ['produtos','fornecedores','prateleiras','lotes','movimentacoes'];
  tables.forEach(t => {
    let sheet = ss.getSheetByName(t);
    if (!sheet) sheet = ss.insertSheet(t);
    sheet.clearContents();
    if (data[t] && data[t].length > 0) {
      const headers = Object.keys(data[t][0]);
      sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
      const rows = data[t].map(r => headers.map(h => r[h] ?? ''));
      sheet.getRange(2, 1, rows.length, headers.length).setValues(rows);
    }
  });
  return ContentService.createTextOutput(JSON.stringify({ok:true})).setMimeType(ContentService.MimeType.JSON);
}
function doGet(e) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const tables = ['produtos','fornecedores','prateleiras','lotes','movimentacoes'];
  const result = {};
  tables.forEach(t => {
    const sheet = ss.getSheetByName(t);
    if (sheet) {
      const vals = sheet.getDataRange().getValues();
      if (vals.length > 1) {
        const headers = vals[0];
        result[t] = vals.slice(1).map(row => {
          const obj = {};
          headers.forEach((h,i) => { obj[h] = row[i]; });
          return obj;
        });
      } else { result[t] = []; }
    } else { result[t] = []; }
  });
  return ContentService.createTextOutput(JSON.stringify(result)).setMimeType(ContentService.MimeType.JSON);
}`;

  const statusColor = syncConfig.status==='connected'?'ok':syncConfig.status==='syncing'?'pulse':'err';
  const statusLabel = syncConfig.status==='connected'?'Ligado':syncConfig.status==='syncing'?'A sincronizar...':syncConfig.status==='never'?'Nunca sincronizado':'Desligado';

  document.getElementById('page-sincronizacao').innerHTML = `
    <div class="page-header">
      <div>
        <div class="page-title">${ICONS.sync} Sincronização</div>
        <div class="page-title-sub">Migração de dados Offline (localStorage) ↔ Online (Google Sheets)</div>
      </div>
    </div>

    <!-- STATUS -->
    <div class="sync-card">
      <div class="sync-card-header">
        <div class="sync-icon" style="background:rgba(0,184,148,0.1);color:var(--accent);">${ICONS.cloud}</div>
        <div>
          <div class="sync-card-title">Estado da Sincronização</div>
          <div class="sync-card-desc">Última sincronização: ${syncConfig.lastSync||'Nunca'}</div>
        </div>
      </div>
      <div class="sync-status-row">
        <div class="sync-dot ${statusColor}"></div>
        <span>${statusLabel}</span>
        ${syncConfig.webAppUrl ? `<span style="margin-left:auto;font-size:11px;color:var(--text-muted);word-break:break-all;">${syncConfig.webAppUrl.substring(0,60)}…</span>` : ''}
      </div>
    </div>

    <!-- CONFIGURAÇÃO -->
    <div class="sync-card">
      <div class="sync-card-header">
        <div class="sync-icon" style="background:rgba(52,152,219,0.1);color:var(--info);">${ICONS.settings}</div>
        <div>
          <div class="sync-card-title">Configuração Google Sheets</div>
          <div class="sync-card-desc">Configure o URL da Google Apps Script Web App</div>
        </div>
      </div>
      <div class="config-field">
        <label>URL da Web App (Google Apps Script) <span style="color:var(--danger)">*</span></label>
        <input id="sync-webapp-url" placeholder="https://script.google.com/macros/s/.../exec" value="${syncConfig.webAppUrl||''}">
      </div>
      <div class="sync-actions">
        <button class="btn btn-primary" onclick="saveSyncSettings()">${ICONS.check}<span class="btn-text-content">Guardar Configuração</span></button>
        <button class="btn btn-secondary" onclick="testSyncConnection()" ${syncConfig.webAppUrl?'':'disabled'}>${ICONS.refresh}<span class="btn-text-content">Testar Ligação</span></button>
      </div>
    </div>

    <!-- ACÇÕES DE SINCRONIZAÇÃO -->
    <div class="grid-2" style="gap:16px;margin-bottom:16px;">
      <div class="sync-card" style="margin-bottom:0;">
        <div class="sync-card-header">
          <div class="sync-icon" style="background:rgba(231,76,60,0.1);color:var(--danger);">${ICONS.upload}</div>
          <div>
            <div class="sync-card-title">Exportar para Google Sheets</div>
            <div class="sync-card-desc">Enviar dados locais (offline) para o Google Sheets (online)</div>
          </div>
        </div>
        <p style="font-size:12px;color:var(--text-secondary);margin-bottom:14px;">
          Envia todos os dados actuais do sistema (produtos, lotes, movimentações, etc.) para o Google Sheets. Os dados online serão substituídos.
        </p>
        <button class="btn btn-danger" onclick="syncLocalToSheets()" ${syncConfig.webAppUrl?'':'disabled'} style="width:100%;">
          ${ICONS.upload}<span class="btn-text-content">Enviar Offline → Online</span>
        </button>
      </div>

      <div class="sync-card" style="margin-bottom:0;">
        <div class="sync-card-header">
          <div class="sync-icon" style="background:rgba(0,184,148,0.1);color:var(--accent);">${ICONS.download}</div>
          <div>
            <div class="sync-card-title">Importar do Google Sheets</div>
            <div class="sync-card-desc">Trazer dados do Google Sheets (online) para o local (offline)</div>
          </div>
        </div>
        <p style="font-size:12px;color:var(--text-secondary);margin-bottom:14px;">
          Importa todos os dados do Google Sheets para o sistema local. Os dados locais actuais serão substituídos pelos dados online.
        </p>
        <button class="btn btn-primary" onclick="syncSheetsToLocal()" ${syncConfig.webAppUrl?'':'disabled'} style="width:100%;">
          ${ICONS.download}<span class="btn-text-content">Receber Online → Offline</span>
        </button>
      </div>
    </div>

    <!-- EXPORTAÇÃO MANUAL XLSX -->
    <div class="sync-card">
      <div class="sync-card-header">
        <div class="sync-icon" style="background:rgba(243,156,18,0.1);color:var(--warning);">${ICONS.download}</div>
        <div>
          <div class="sync-card-title">Exportar para XLSX (backup local)</div>
          <div class="sync-card-desc">Guardar todos os dados em ficheiro Excel como backup</div>
        </div>
      </div>
      <div class="sync-actions">
        <button class="btn btn-secondary" onclick="exportDBXLSX()">${ICONS.download}<span class="btn-text-content">Exportar XLSX</span></button>
        <label class="btn btn-secondary" style="cursor:pointer;">
          ${ICONS.upload}<span class="btn-text-content">Importar XLSX</span>
          <input type="file" accept=".xlsx,.xls" style="display:none;" onchange="importDBXLSX(event)">
        </label>
      </div>
    </div>

    <!-- INSTRUÇÕES CONFIGURAÇÃO GOOGLE APPS SCRIPT -->
    <div class="sync-card">
      <div class="sync-card-header">
        <div class="sync-icon" style="background:rgba(155,89,182,0.1);color:#9B59B6;">${ICONS.info}</div>
        <div>
          <div class="sync-card-title">Como Configurar o Google Apps Script</div>
          <div class="sync-card-desc">Siga estes passos para activar a sincronização com Google Sheets</div>
        </div>
      </div>
      <ol class="setup-steps-list">
        <li>Abra o <a href="https://sheets.google.com" target="_blank" style="color:var(--accent)">Google Sheets</a> e crie uma nova folha de cálculo</li>
        <li>Clique em <code>Extensões</code> → <code>Apps Script</code></li>
        <li>Cole o código abaixo no editor e guarde (<code>Ctrl+S</code>)</li>
        <li>Clique em <code>Implementar</code> → <code>Nova implementação</code></li>
        <li>Escolha <strong>Tipo: Aplicação Web</strong>, Acesso: <strong>Qualquer pessoa</strong></li>
        <li>Clique em <code>Implementar</code> e copie o URL da Web App</li>
        <li>Cole o URL no campo "Configuração" acima e clique em "Guardar"</li>
      </ol>
      <div style="margin-top:12px;font-size:12px;color:var(--text-muted);">Código Google Apps Script:</div>
      <div class="script-code">${GAS_SCRIPT.replace(/</g,'&lt;').replace(/>/g,'&gt;')}</div>
      <button class="btn btn-secondary" style="margin-top:10px;" onclick="copyGASScript()">
        ${ICONS.check}<span class="btn-text-content">Copiar Código</span>
      </button>
    </div>
  `;
}

function saveSyncSettings() {
  syncConfig.webAppUrl = document.getElementById('sync-webapp-url').value.trim();
  saveSyncConfig();
  toast('success','Configuração guardada');
  renderSincronizacao();
}

async function testSyncConnection() {
  if (!syncConfig.webAppUrl) { toast('error','URL não configurado'); return; }
  toast('info','A testar ligação...','Por favor aguarde');
  try {
    const resp = await fetch(syncConfig.webAppUrl, { method:'GET', mode:'cors' });
    if (resp.ok) {
      syncConfig.status = 'connected';
      saveSyncConfig();
      toast('success','Ligação bem sucedida!','Google Sheets acessível');
    } else {
      throw new Error('HTTP '+resp.status);
    }
  } catch(e) {
    syncConfig.status = 'disconnected';
    saveSyncConfig();
    toast('error','Falha na ligação',e.message+'. Verifique o URL e as permissões.');
  }
  renderSincronizacao();
}

async function syncLocalToSheets() {
  if (!syncConfig.webAppUrl) { toast('error','URL não configurado'); return; }
  const ok = await confirm('Exportar para Google Sheets','Os dados online serão substituídos pelos dados locais actuais. Continuar?');
  if (!ok) return;
  toast('info','A enviar dados para Google Sheets...','Por favor aguarde');
  syncConfig.status = 'syncing';
  saveSyncConfig();
  renderSincronizacao();
  try {
    const payload = {
      produtos: db.getAll('produtos',true),
      fornecedores: db.getAll('fornecedores',true),
      prateleiras: db.getAll('prateleiras',true),
      lotes: db.getAll('lotes',true),
      movimentacoes: db.getAll('movimentacoes',true),
    };
    const resp = await fetch(syncConfig.webAppUrl, {
      method:'POST',
      mode:'cors',
      headers:{'Content-Type':'application/json'},
      body: JSON.stringify(payload),
    });
    if (resp.ok) {
      syncConfig.status = 'connected';
      syncConfig.lastSync = new Date().toLocaleString('pt-AO');
      saveSyncConfig();
      toast('success','Dados enviados com sucesso!','Google Sheets actualizado');
    } else { throw new Error('HTTP '+resp.status); }
  } catch(e) {
    syncConfig.status = 'disconnected';
    saveSyncConfig();
    toast('error','Erro ao enviar dados',e.message);
  }
  renderSincronizacao();
}

async function syncSheetsToLocal() {
  if (!syncConfig.webAppUrl) { toast('error','URL não configurado'); return; }
  const ok = await confirm('Importar do Google Sheets','Os dados locais actuais serão substituídos pelos dados do Google Sheets. Continuar?');
  if (!ok) return;
  toast('info','A receber dados do Google Sheets...','Por favor aguarde');
  syncConfig.status = 'syncing';
  saveSyncConfig();
  renderSincronizacao();
  try {
    const resp = await fetch(syncConfig.webAppUrl+'?t='+Date.now(), { method:'GET', mode:'cors' });
    if (!resp.ok) throw new Error('HTTP '+resp.status);
    const data = await resp.json();
    const tables = ['produtos','fornecedores','prateleiras','lotes','movimentacoes'];
    tables.forEach(t => { if (Array.isArray(data[t])) db.data[t] = data[t]; });
    db.save();
    syncConfig.status = 'connected';
    syncConfig.lastSync = new Date().toLocaleString('pt-AO');
    saveSyncConfig();
    toast('success','Dados recebidos com sucesso!','Base de dados local actualizada');
    updateAlertBadge();
  } catch(e) {
    syncConfig.status = 'disconnected';
    saveSyncConfig();
    toast('error','Erro ao receber dados',e.message);
  }
  renderSincronizacao();
}

function copyGASScript() {
  const script = `// Google Apps Script — Cole este código em Extensions > Apps Script
function doPost(e) {
  const data = JSON.parse(e.postData.contents);
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const tables = ['produtos','fornecedores','prateleiras','lotes','movimentacoes'];
  tables.forEach(t => {
    let sheet = ss.getSheetByName(t);
    if (!sheet) sheet = ss.insertSheet(t);
    sheet.clearContents();
    if (data[t] && data[t].length > 0) {
      const headers = Object.keys(data[t][0]);
      sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
      const rows = data[t].map(r => headers.map(h => r[h] ?? ''));
      sheet.getRange(2, 1, rows.length, headers.length).setValues(rows);
    }
  });
  return ContentService.createTextOutput(JSON.stringify({ok:true})).setMimeType(ContentService.MimeType.JSON);
}
function doGet(e) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const tables = ['produtos','fornecedores','prateleiras','lotes','movimentacoes'];
  const result = {};
  tables.forEach(t => {
    const sheet = ss.getSheetByName(t);
    if (sheet) {
      const vals = sheet.getDataRange().getValues();
      if (vals.length > 1) {
        const headers = vals[0];
        result[t] = vals.slice(1).map(row => {
          const obj = {};
          headers.forEach((h,i) => { obj[h] = row[i]; });
          return obj;
        });
      } else { result[t] = []; }
    } else { result[t] = []; }
  });
  return ContentService.createTextOutput(JSON.stringify(result)).setMimeType(ContentService.MimeType.JSON);
}`;
  navigator.clipboard.writeText(script).then(()=>toast('success','Código copiado!','Cole no editor do Apps Script')).catch(()=>toast('error','Erro ao copiar'));
}

// ===================== MODAL HELPERS =====================
function closeModal(id) {
  const el = document.getElementById(id);
  if (el) el.classList.remove('open');
  editingId = null;
  userEditingId = null;
}

document.addEventListener('click', (e) => {
  if (e.target.classList.contains('modal-overlay')) {
    e.target.classList.remove('open');
    editingId = null;
    userEditingId = null;
  }
});

// ===================== CONFIRM DIALOG =====================
document.getElementById('confirm-yes').addEventListener('click', () => {
  document.getElementById('confirm-overlay').classList.remove('open');
  if (confirmResolve) { confirmResolve(true); confirmResolve = null; }
});
document.getElementById('confirm-no').addEventListener('click', () => {
  document.getElementById('confirm-overlay').classList.remove('open');
  if (confirmResolve) { confirmResolve(false); confirmResolve = null; }
});

// ===================== HEADER BUTTONS =====================
document.getElementById('header-notif-btn').addEventListener('click', () => navigateTo('alertas'));

// ===================== BOOTSTRAP =====================
document.addEventListener('DOMContentLoaded', () => {
  showScreen('splash');
  startSplash();
  setupLogin();
});
