(() => {
  "use strict";

  const WATCH_DRAFT_KEY = "lenaic-express-watch-draft-v1";
  const EXPRESS_SNAPSHOT_KEY = "lenaic-express-snapshot-v1";
  const state = {
    data: null,
    preferences: null,
    serverWatches: [],
    articles: [],
    activeFilter: "all",
    saved: new Set(JSON.parse(localStorage.getItem("lex_saved") || "[]")),
    hidden: new Set(JSON.parse(localStorage.getItem("lex_hidden") || "[]")),
    hiddenSources: new Set(JSON.parse(localStorage.getItem("lex_hidden_sources") || "[]")),
    categoryBoosts: JSON.parse(localStorage.getItem("lex_category_boosts") || "{}"),
    localWatches: new Set(JSON.parse(localStorage.getItem(WATCH_DRAFT_KEY) || "[]"))
  };

  const $ = (s, root=document) => root.querySelector(s);
  const $$ = (s, root=document) => [...root.querySelectorAll(s)];
  const esc = v => String(v ?? "").replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;","'":"&#39;"}[c]));
  const norm = s => String(s ?? "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/\s+/g," ").trim();
  const categoryLabels = {
    politique: "Politique",
    sondages: "Sondages",
    local: "Local",
    medias: "Médias / TV",
    genealogie: "Généalogie",
    histoire: "Histoire / patrimoine",
    tech: "Tech / IA",
    sciences: "Sciences / société",
    culture: "Culture",
    international: "International",
    general: "Actualité"
  };
  const categoryIcons = {
    politique:"◆",sondages:"▥",local:"⌖",medias:"▤",genealogie:"♟",histoire:"⌂",
    tech:"▣",sciences:"◉",culture:"✦",international:"◎",general:"◇"
  };
  let lastSnapshotSignature = "";

  function saveState(){
    localStorage.setItem("lex_saved", JSON.stringify([...state.saved]));
    localStorage.setItem("lex_hidden", JSON.stringify([...state.hidden]));
    localStorage.setItem("lex_hidden_sources", JSON.stringify([...state.hiddenSources]));
    localStorage.setItem("lex_category_boosts", JSON.stringify(state.categoryBoosts));
    localStorage.setItem(WATCH_DRAFT_KEY, JSON.stringify([...state.localWatches]));
  }

  function parseDate(value){
    const d = value ? new Date(value) : null;
    return d && !isNaN(d) ? d : new Date(0);
  }

  function ageHours(article){
    return (Date.now() - parseDate(article.published_at).getTime()) / 36e5;
  }

  function publishedWatchTerms(){
    return state.serverWatches.filter(w => w && w.enabled !== false && String(w.term || "").trim()).map(w => String(w.term).trim());
  }

  function watchMatches(article){
    const fromServer = Array.isArray(article.watch_matches) ? article.watch_matches.filter(Boolean) : [];
    const hay = norm(`${article.title || ""} ${article.summary || ""} ${article.ai_summary || ""} ${article.source || ""}`);
    const local = [...state.localWatches].filter(term => term && hay.includes(norm(term)));
    return [...new Set([...fromServer, ...local])];
  }

  function personalizedArticles(){
    return state.articles
      .filter(a => !state.hidden.has(a.id) && !state.hiddenSources.has(a.source))
      .sort((a,b) => localScore(b) - localScore(a));
  }

  function publishExpressSnapshot(){
    if(!state.data) return;
    const top = personalizedArticles().slice(0,5).map(a => ({
      id:a.id,
      title:a.title,
      category:a.category,
      categoryLabel:categoryLabels[a.category] || a.category || "Actualité",
      source:a.source || "Source",
      url:articleUrl(a),
      publishedAt:a.published_at || null,
      score:localScore(a),
      watchMatches:watchMatches(a),
      summary:summaryText(a)
    }));
    const payload={
      generatedAt:new Date().toISOString(),
      editionGeneratedAt:state.data.generated_at || null,
      count:state.articles.length,
      watchCount:top.filter(a=>a.watchMatches.length).length,
      top
    };
    const signature=JSON.stringify(top.map(a=>[a.id,a.score,a.watchMatches]));
    try{localStorage.setItem(EXPRESS_SNAPSHOT_KEY,JSON.stringify(payload))}catch(e){}
    if(window.LenaicBus && signature!==lastSnapshotSignature){
      lastSnapshotSignature=signature;
      try{LenaicBus.publish("news.snapshot",payload,{source:"lenaic-express",target:"3615"})}catch(e){}
    }
  }

  function localScore(article){
    const boost = Number(state.categoryBoosts[article.category] || 0);
    const age = Math.max(0, ageHours(article));
    const recency = Math.max(0, 30 - age / 6);
    const watchBoost = watchMatches(article).length ? 220 : 0;
    return Number(article.score || 0) + boost * 9 + recency + watchBoost;
  }

  function visibleArticles(){
    let arr = state.articles.filter(a => !state.hidden.has(a.id) && !state.hiddenSources.has(a.source));
    if(state.activeFilter === "saved") arr = arr.filter(a => state.saved.has(a.id));
    else if(state.activeFilter === "recent") arr = arr.filter(a => ageHours(a) <= 48);
    else if(state.activeFilter === "watch") arr = arr.filter(a => watchMatches(a).length);
    else if(state.activeFilter !== "all") arr = arr.filter(a => a.category === state.activeFilter);
    return arr.sort((a,b) => localScore(b) - localScore(a));
  }

  function articleUrl(a){ return a.resolved_url || a.url || "#"; }
  function summaryText(a){ return String(a.ai_summary || a.summary || "").trim(); }
  function summaryKind(a){
    if(a.ai_summary){
      if(a.ai_summary_basis === "article") return "Résumé IA · article";
      if(a.ai_summary_basis === "rss") return "Résumé IA · chapô/RSS";
      return "Résumé IA";
    }
    return a.summary ? "Extrait source" : "";
  }
  function whyText(a){
    const reasons = Array.isArray(a.why_for_you) ? a.why_for_you : [];
    return reasons.join(" · ");
  }

  function watchBadges(a){
    const matches = watchMatches(a);
    return matches.map(x => `<span class="watch-badge">● VEILLE · ${esc(x)}</span>`).join("");
  }

  function accessBadges(a){
    const parts=[];
    if(a.paywalled) parts.push(`<span class="access-badge paywall">🔒 PAYANT</span>`);
    if(a.archive_status === "found") parts.push(`<span class="access-badge archive-ok">ARCHIVE TROUVÉE</span>`);
    return parts.join("");
  }

  function articleLinks(a, compact=false){
    const original = `<a class="${compact?"story-link":"read-link"}" href="${esc(articleUrl(a))}" target="_blank" rel="noopener noreferrer">Article original ↗</a>`;
    if(!a.paywalled || !a.archive_url) return original;
    const label = a.archive_status === "found" ? "Archive disponible ↗" : "Chercher une archive ↗";
    return `${original}<a class="${compact?"story-link":"read-link"} archive-link" href="${esc(a.archive_url)}" target="_blank" rel="noopener noreferrer">${label}</a>`;
  }

  function img(article, className=""){
    if(article.image){
      return `<div class="${className}"><img src="${esc(article.image)}" alt="" loading="lazy" referrerpolicy="no-referrer" onerror="this.parentElement.innerHTML='<div class=&quot;fallback-art&quot;>${categoryIcons[article.category] || "◆"}</div>'"></div>`;
    }
    return `<div class="${className}"><div class="fallback-art">${categoryIcons[article.category] || "◆"}</div></div>`;
  }

  function sourceLine(a){
    const d = parseDate(a.published_at);
    const date = d.getTime() ? d.toLocaleDateString("fr-FR",{day:"numeric",month:"short"}) : "";
    return `${esc(a.source || "Source")} ${date ? "· " + esc(date) : ""}`;
  }

  function summaryHtml(a, cls="summary"){
    const text = summaryText(a);
    if(!text) return "";
    return `<div class="summary-wrap"><span class="summary-label">${esc(summaryKind(a))}</span><p class="${cls}">${esc(text)}</p></div>`;
  }

  function renderWatchStrip(){
    const strip = $("#watchStrip");
    const rows = personalizedArticles().filter(a=>watchMatches(a).length);
    if(!rows.length){ strip.hidden=true; strip.innerHTML=""; return; }
    const terms=[...new Set(rows.flatMap(watchMatches))].slice(0,5);
    strip.hidden=false;
    strip.innerHTML=`<button type="button" data-filter="watch"><strong>● MES VEILLES</strong><span>${rows.length} correspondance${rows.length>1?"s":""}</span><small>${terms.map(esc).join(" · ")}</small></button>`;
  }

  function renderFront(){
    const arr = visibleArticles();
    const front = $("#frontPage");
    if(!arr.length){
      front.innerHTML = `<div class="empty">Aucun article pour ce filtre.</div>`;
      return;
    }
    const hero = arr[0];
    const secondary = arr.slice(1,3);
    const rail = arr.slice(3,7);

    front.innerHTML = `
      <div class="hero-grid">
        <div class="hero-left">
          <article class="hero">
            <div class="badge-line">${watchBadges(hero)}${accessBadges(hero)}</div>
            <div class="kicker">À la une · ${esc(categoryLabels[hero.category] || hero.category)}</div>
            <h2>${esc(hero.title)}</h2>
            ${summaryHtml(hero,"dek")}
            <div class="hero-body">
              <div>
                ${whyText(hero)?`<p class="why"><b>Pourquoi ici ?</b> ${esc(whyText(hero))}</p>`:""}
                <div class="link-row">${articleLinks(hero)}</div>
              </div>
              <div>
                ${img(hero,"hero-image")}
                <div class="caption">${sourceLine(hero)}</div>
              </div>
            </div>
          </article>
          <div>
            ${secondary.map(a => `
              <article class="secondary">
                <div class="badge-line">${watchBadges(a)}${accessBadges(a)}</div>
                <div class="kicker">${esc(categoryLabels[a.category] || a.category)}</div>
                <h3>${esc(a.title)}</h3>
                ${img(a,"secondary-image")}
                ${summaryHtml(a)}
                <div class="link-row">${articleLinks(a,true)}</div>
              </article>`).join("")}
          </div>
        </div>
        <aside class="rail">
          <section>
            <h3>Votre édition</h3>
            <p>Politique, sondages, local, médias, histoire, généalogie et tech sont mélangés avec fraîcheur, diversité et vos veilles.</p>
            <div class="interests">
              ${Object.entries(state.preferences.categories || {})
                .sort((a,b)=>Number(b[1].weight)-Number(a[1].weight))
                .slice(0,5)
                .map(([key,val])=>`<div class="interest"><span>${categoryIcons[key]||"◆"}</span><div><b>${esc(val.label||categoryLabels[key]||key)}</b><small>Priorité ${esc(val.weight)}</small></div></div>`).join("")}
            </div>
          </section>
          <section>
            <h3>À ne pas manquer</h3>
            ${rail.map(a => `<article class="rail-story">${watchBadges(a)}<div class="kicker">${esc(categoryLabels[a.category]||a.category)}</div><h4>${esc(a.title)}</h4><div class="story-meta">${sourceLine(a)}</div><div class="link-row">${articleLinks(a,true)}</div></article>`).join("")}
          </section>
        </aside>
      </div>`;
  }

  function storyCard(a){
    const saved = state.saved.has(a.id);
    return `
      <article class="story" data-id="${esc(a.id)}">
        <div class="badge-line">${watchBadges(a)}${accessBadges(a)}</div>
        <div class="story-category">${esc(categoryLabels[a.category] || a.category)}</div>
        <h3><a href="${esc(articleUrl(a))}" target="_blank" rel="noopener noreferrer">${esc(a.title)}</a></h3>
        ${summaryHtml(a)}
        ${whyText(a)?`<div class="why-mini">Pourquoi ici : ${esc(whyText(a))}</div>`:""}
        <div class="story-meta">${sourceLine(a)}</div>
        <div class="inline-links">${articleLinks(a,true)}</div>
        <div class="story-actions">
          <button class="save ${saved ? "saved" : ""}" data-action="save" title="À lire">${saved ? "★" : "☆"}</button>
          <button class="more" data-action="menu" title="Personnaliser">···</button>
        </div>
        <div class="story-menu" hidden>
          <button data-action="more-like">Plus comme ça</button>
          <button data-action="less-like">Moins comme ça</button>
          <button data-action="hide">Masquer cet article</button>
          <button data-action="hide-source">Masquer ${esc(a.source)}</button>
        </div>
      </article>`;
  }

  function renderFeed(){
    const arr = visibleArticles();
    const used = new Set(arr.slice(0,7).map(a => a.id));
    let rest = arr.filter(a => !used.has(a.id));
    if(state.activeFilter === "saved" || state.activeFilter === "watch") rest = arr;
    const title = state.activeFilter === "saved" ? "À lire" : state.activeFilter === "watch" ? "Mes veilles" : "Le fil";
    $("#feed").innerHTML = `
      <div class="feed-heading"><h2>${title}</h2><small>${arr.length} article${arr.length>1?"s":""}</small></div>
      <div class="feed-grid">${rest.length ? rest.map(storyCard).join("") : `<div class="empty">Rien d’autre pour le moment.</div>`}</div>`;
  }

  function render(){
    renderWatchStrip();
    renderFront();
    renderFeed();
    $$("#sections button[data-filter]").forEach(b => b.classList.toggle("active", b.dataset.filter === state.activeFilter));
    publishExpressSnapshot();
  }

  function setFilter(filter){
    state.activeFilter = filter;
    render();
    window.scrollTo({top:0,behavior:"smooth"});
  }

  function findArticle(id){ return state.articles.find(a => a.id === id); }

  document.addEventListener("click", e => {
    const filter = e.target.closest("[data-filter]")?.dataset.filter;
    if(filter){ setFilter(filter); return; }
    const mobileFilter = e.target.closest("[data-mobile-filter]")?.dataset.mobileFilter;
    if(mobileFilter){ setFilter(mobileFilter); return; }

    const story = e.target.closest(".story");
    const action = e.target.closest("[data-action]")?.dataset.action;
    if(!story || !action) return;
    const a = findArticle(story.dataset.id);
    if(!a) return;

    if(action === "menu"){
      const menu = $(".story-menu", story);
      menu.hidden = !menu.hidden;
      return;
    }
    if(action === "save") state.saved.has(a.id) ? state.saved.delete(a.id) : state.saved.add(a.id);
    if(action === "more-like") state.categoryBoosts[a.category] = Number(state.categoryBoosts[a.category] || 0) + 1;
    if(action === "less-like") state.categoryBoosts[a.category] = Number(state.categoryBoosts[a.category] || 0) - 1;
    if(action === "hide") state.hidden.add(a.id);
    if(action === "hide-source") state.hiddenSources.add(a.source);
    saveState(); render();
  });

  function openModal(id){ const m=$(id); m.classList.add("open"); m.setAttribute("aria-hidden","false"); }
  function closeModal(id){ const m=$(id); m.classList.remove("open"); m.setAttribute("aria-hidden","true"); }

  $("#searchButton").addEventListener("click",()=>{ openModal("#searchModal"); setTimeout(()=>$("#searchInput").focus(),20); });
  $("#mobileSearch").addEventListener("click",()=>{ openModal("#searchModal"); setTimeout(()=>$("#searchInput").focus(),20); });
  $("#closeSearch").addEventListener("click",()=>closeModal("#searchModal"));
  $("#searchModal").addEventListener("click",e=>{ if(e.target.id==="searchModal") closeModal("#searchModal"); });
  $("#mobileTopics").addEventListener("click",()=>openModal("#topicsModal"));
  $("#closeTopics").addEventListener("click",()=>closeModal("#topicsModal"));
  $("#topicsModal").addEventListener("click",e=>{ if(e.target.id==="topicsModal") closeModal("#topicsModal"); });

  $("#searchInput").addEventListener("input", e => {
    const q = norm(e.target.value.trim());
    const rows = state.articles.filter(a => !q || norm(`${a.title} ${summaryText(a)} ${a.source}`).includes(q)).slice(0,30);
    $("#searchResults").innerHTML = rows.map(a => `<div class="search-row">${watchBadges(a)}<div class="kicker">${esc(categoryLabels[a.category]||a.category)} · ${esc(a.source)}</div><a href="${esc(articleUrl(a))}" target="_blank" rel="noopener noreferrer">${esc(a.title)}</a></div>`).join("");
  });

  function renderTopics(){
    const categories = state.preferences.categories || {};
    $("#topicControls").innerHTML = Object.entries(categories).map(([key,val]) => `
      <label class="topic-row">
        <span><b>${esc(val.label || categoryLabels[key] || key)}</b><br><small>Influence le tri dans ce navigateur.</small></span>
        <input type="range" min="-2" max="4" step="1" value="${esc(state.categoryBoosts[key] ?? 0)}" data-topic="${esc(key)}">
      </label>`).join("");
    $$("#topicControls input").forEach(input => input.addEventListener("input", () => {
      state.categoryBoosts[input.dataset.topic] = Number(input.value);
      saveState(); publishExpressSnapshot();
    }));
    renderWatchManager();
  }

  function renderWatchManager(){
    const server = new Set(publishedWatchTerms().map(norm));
    const rows=[];
    for(const term of publishedWatchTerms()) rows.push(`<div class="watch-row"><span><b>${esc(term)}</b><small>PUBLIÉ · recherche internet automatique</small></span><span class="watch-state published">NEXUS</span></div>`);
    for(const term of [...state.localWatches].filter(t=>!server.has(norm(t)))) rows.push(`<div class="watch-row"><span><b>${esc(term)}</b><small>LOCAL · priorise l’édition déjà récupérée</small></span><button type="button" class="watch-remove" data-remove-watch="${esc(term)}">×</button></div>`);
    $("#watchList").innerHTML = rows.length ? rows.join("") : `<div class="small watch-empty">Aucune veille. Ajoute un mot ou une expression ci-dessus.</div>`;
    $$("[data-remove-watch]").forEach(btn=>btn.onclick=()=>{
      state.localWatches.delete(btn.dataset.removeWatch); saveState(); renderWatchManager(); render();
    });
  }

  function addLocalWatch(){
    const input=$("#watchInput"),term=input.value.trim();
    if(!term) return;
    const published = publishedWatchTerms().some(x=>norm(x)===norm(term));
    if(!published) state.localWatches.add(term);
    input.value=""; saveState(); renderWatchManager(); render();
    try{window.LenaicBus?.publish?.("news.watch_draft_changed",{terms:[...state.localWatches]},{source:"lenaic-express",target:"nexus"})}catch(e){}
  }
  $("#addWatchBtn").addEventListener("click",addLocalWatch);
  $("#watchInput").addEventListener("keydown",e=>{if(e.key==="Enter"){e.preventDefault();addLocalWatch();}});

  $("#resetPrefs").addEventListener("click",()=>{
    state.categoryBoosts = {};
    state.hidden.clear();
    state.hiddenSources.clear();
    saveState(); renderTopics(); render();
  });

  async function init(){
    try{
      const [newsRes,prefsRes,watchesRes] = await Promise.all([
        fetch("data/actualites.json?ts="+Date.now()),
        fetch("preferences.json?ts="+Date.now()),
        fetch("veilles.json?ts="+Date.now())
      ]);
      if(!newsRes.ok) throw new Error("actualites.json introuvable");
      state.data = await newsRes.json();
      state.preferences = prefsRes.ok ? await prefsRes.json() : {categories:{}};
      const watches = watchesRes.ok ? await watchesRes.json() : {watches:[]};
      state.serverWatches = Array.isArray(watches.watches) ? watches.watches : [];
      state.articles = Array.isArray(state.data.articles) ? state.data.articles : [];

      const updated = parseDate(state.data.generated_at);
      $("#updateShort").textContent = updated.getTime() ? updated.toLocaleString("fr-FR",{day:"2-digit",month:"2-digit",hour:"2-digit",minute:"2-digit"}) : "—";
      const now = new Date();
      $("#today").textContent = now.toLocaleDateString("fr-FR",{weekday:"long",day:"numeric",month:"long",year:"numeric"});
      const base = new Date("2026-01-01");
      $("#issue").textContent = "N° " + (200 + Math.max(0,Math.floor((now-base)/86400000)));
      const aiCount=state.articles.filter(a=>a.ai_summary).length;
      $("#count").textContent = `${state.articles.length} article${state.articles.length>1?"s":""}${aiCount?` · ${aiCount} résumés IA`:""}`;

      renderTopics(); render();
      $("#loading").hidden = true;
      $("#app").hidden = false;
    }catch(err){
      $("#loading").innerHTML = `<strong>Impossible de charger l’édition.</strong><br><small>${esc(err.message)}. Ouvrez le site via GitHub Pages ou un serveur local, pas directement en file://.</small>`;
    }
  }

  init();
})();
