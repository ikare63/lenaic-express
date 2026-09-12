
(() => {
  "use strict";

  const state = {
    data: null,
    preferences: null,
    articles: [],
    activeFilter: "all",
    saved: new Set(JSON.parse(localStorage.getItem("lex_saved") || "[]")),
    hidden: new Set(JSON.parse(localStorage.getItem("lex_hidden") || "[]")),
    hiddenSources: new Set(JSON.parse(localStorage.getItem("lex_hidden_sources") || "[]")),
    categoryBoosts: JSON.parse(localStorage.getItem("lex_category_boosts") || "{}")
  };

  const $ = (s, root=document) => root.querySelector(s);
  const $$ = (s, root=document) => [...root.querySelectorAll(s)];
  const esc = v => String(v ?? "").replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;","'":"&#39;"}[c]));
  const categoryLabels = {
    genealogie: "Généalogie",
    histoire: "Histoire",
    local: "Actualité locale",
    tech: "Web / Tech",
    culture: "Culture",
    sciences: "Sciences",
    general: "Actualité"
  };
  const categoryIcons = {genealogie:"♟",histoire:"⌂",local:"⌖",tech:"▣",culture:"✦",sciences:"◉",general:"◆"};

  const EXPRESS_SNAPSHOT_KEY = "lenaic-express-snapshot-v1";
  let lastSnapshotSignature = "";

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
      url:a.url || "",
      publishedAt:a.published_at || null,
      score:localScore(a)
    }));
    const payload={
      generatedAt:new Date().toISOString(),
      editionGeneratedAt:state.data.generated_at || null,
      count:state.articles.length,
      top
    };
    const signature=JSON.stringify(top.map(a=>[a.id,a.score]));
    try{localStorage.setItem(EXPRESS_SNAPSHOT_KEY,JSON.stringify(payload))}catch(e){}
    if(window.LenaicBus && signature!==lastSnapshotSignature){
      lastSnapshotSignature=signature;
      LenaicBus.publish('news.snapshot',payload,{source:'lenaic-express',target:'3615'});
    }
  }

  function saveState(){
    localStorage.setItem("lex_saved", JSON.stringify([...state.saved]));
    localStorage.setItem("lex_hidden", JSON.stringify([...state.hidden]));
    localStorage.setItem("lex_hidden_sources", JSON.stringify([...state.hiddenSources]));
    localStorage.setItem("lex_category_boosts", JSON.stringify(state.categoryBoosts));
  }

  function parseDate(value){
    const d = value ? new Date(value) : null;
    return d && !isNaN(d) ? d : new Date(0);
  }

  function ageHours(article){
    return (Date.now() - parseDate(article.published_at).getTime()) / 36e5;
  }

  function localScore(article){
    const boost = Number(state.categoryBoosts[article.category] || 0);
    const age = Math.max(0, ageHours(article));
    const recency = Math.max(0, 30 - age / 6);
    return Number(article.score || 0) + boost * 9 + recency;
  }

  function visibleArticles(){
    let arr = state.articles.filter(a => !state.hidden.has(a.id) && !state.hiddenSources.has(a.source));
    if(state.activeFilter === "saved") arr = arr.filter(a => state.saved.has(a.id));
    else if(state.activeFilter === "recent") arr = arr.filter(a => ageHours(a) <= 48);
    else if(state.activeFilter !== "all") arr = arr.filter(a => a.category === state.activeFilter);
    return arr.sort((a,b) => localScore(b) - localScore(a));
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
            <div class="kicker">À la une · ${esc(categoryLabels[hero.category] || hero.category)}</div>
            <h2>${esc(hero.title)}</h2>
            <p class="dek">${esc(hero.summary || "")}</p>
            <div class="hero-body">
              <div>
                <p class="hero-summary">${esc(hero.summary || "Ouvrez l’article pour poursuivre la lecture sur le site source.")}</p>
                <a class="read-link" href="${esc(hero.url)}" target="_blank" rel="noopener noreferrer">Lire l’article ↗</a>
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
                <div class="kicker">${esc(categoryLabels[a.category] || a.category)}</div>
                <h3>${esc(a.title)}</h3>
                ${img(a,"secondary-image")}
                <p>${esc(a.summary || "")}</p>
                <a class="story-link" href="${esc(a.url)}" target="_blank" rel="noopener noreferrer">Lire chez ${esc(a.source)} ↗</a>
              </article>`).join("")}
          </div>
        </div>
        <aside class="rail">
          <section>
            <h3>Pourquoi pour vous ?</h3>
            <p>Le classement mélange vos sujets favoris, la fraîcheur et la priorité des sources.</p>
            <div class="interests">
              ${Object.entries(state.preferences.categories || {})
                .sort((a,b)=>Number(b[1].weight)-Number(a[1].weight))
                .slice(0,4)
                .map(([key,val])=>`<div class="interest"><span>${categoryIcons[key]||"◆"}</span><div><b>${esc(val.label||categoryLabels[key]||key)}</b><small>Priorité ${esc(val.weight)}</small></div></div>`).join("")}
            </div>
          </section>
          <section>
            <h3>À ne pas manquer</h3>
            ${rail.map(a => `<article class="rail-story"><div class="kicker">${esc(categoryLabels[a.category]||a.category)}</div><h4>${esc(a.title)}</h4><div class="story-meta">${sourceLine(a)}</div><a class="story-link" href="${esc(a.url)}" target="_blank" rel="noopener noreferrer">Lire ↗</a></article>`).join("")}
          </section>
        </aside>
      </div>`;
  }

  function storyCard(a){
    const saved = state.saved.has(a.id);
    return `
      <article class="story" data-id="${esc(a.id)}">
        <div class="story-category">${esc(categoryLabels[a.category] || a.category)}</div>
        <h3><a href="${esc(a.url)}" target="_blank" rel="noopener noreferrer">${esc(a.title)}</a></h3>
        <p class="summary">${esc(a.summary || "")}</p>
        <div class="story-meta">${sourceLine(a)}</div>
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
    if(state.activeFilter === "saved") rest = arr;
    $("#feed").innerHTML = `
      <div class="feed-heading"><h2>${state.activeFilter==="saved" ? "À lire" : "Le fil"}</h2><small>${arr.length} article${arr.length>1?"s":""}</small></div>
      <div class="feed-grid">${rest.length ? rest.map(storyCard).join("") : `<div class="empty">Rien d’autre pour le moment.</div>`}</div>`;
  }

  function render(){
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
    if(action === "save"){
      state.saved.has(a.id) ? state.saved.delete(a.id) : state.saved.add(a.id);
    }
    if(action === "more-like"){
      state.categoryBoosts[a.category] = Number(state.categoryBoosts[a.category] || 0) + 1;
    }
    if(action === "less-like"){
      state.categoryBoosts[a.category] = Number(state.categoryBoosts[a.category] || 0) - 1;
    }
    if(action === "hide") state.hidden.add(a.id);
    if(action === "hide-source") state.hiddenSources.add(a.source);
    saveState();
    render();
  });

  function openModal(id){
    const m = $(id); m.classList.add("open"); m.setAttribute("aria-hidden","false");
  }
  function closeModal(id){
    const m = $(id); m.classList.remove("open"); m.setAttribute("aria-hidden","true");
  }

  $("#searchButton").addEventListener("click",()=>{ openModal("#searchModal"); setTimeout(()=>$("#searchInput").focus(),20); });
  $("#mobileSearch").addEventListener("click",()=>{ openModal("#searchModal"); setTimeout(()=>$("#searchInput").focus(),20); });
  $("#closeSearch").addEventListener("click",()=>closeModal("#searchModal"));
  $("#searchModal").addEventListener("click",e=>{ if(e.target.id==="searchModal") closeModal("#searchModal"); });

  $("#mobileTopics").addEventListener("click",()=>openModal("#topicsModal"));
  $("#closeTopics").addEventListener("click",()=>closeModal("#topicsModal"));
  $("#topicsModal").addEventListener("click",e=>{ if(e.target.id==="topicsModal") closeModal("#topicsModal"); });

  $("#searchInput").addEventListener("input", e => {
    const q = e.target.value.trim().toLowerCase();
    const rows = state.articles.filter(a => !q || `${a.title} ${a.summary} ${a.source}`.toLowerCase().includes(q)).slice(0,20);
    $("#searchResults").innerHTML = rows.map(a => `<div class="search-row"><div class="kicker">${esc(categoryLabels[a.category]||a.category)} · ${esc(a.source)}</div><a href="${esc(a.url)}" target="_blank" rel="noopener noreferrer">${esc(a.title)}</a></div>`).join("");
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
      saveState();
      publishExpressSnapshot();
    }));
  }

  $("#resetPrefs").addEventListener("click",()=>{
    state.categoryBoosts = {};
    state.hidden.clear();
    state.hiddenSources.clear();
    saveState();
    renderTopics();
    render();
  });

  async function init(){
    try{
      const [newsRes,prefsRes] = await Promise.all([
        fetch("data/actualites.json?ts="+Date.now()),
        fetch("preferences.json?ts="+Date.now())
      ]);
      if(!newsRes.ok) throw new Error("actualites.json introuvable");
      state.data = await newsRes.json();
      state.preferences = prefsRes.ok ? await prefsRes.json() : {categories:{}};
      state.articles = Array.isArray(state.data.articles) ? state.data.articles : [];

      const updated = parseDate(state.data.generated_at);
      $("#updateShort").textContent = updated.getTime() ? updated.toLocaleString("fr-FR",{day:"2-digit",month:"2-digit",hour:"2-digit",minute:"2-digit"}) : "—";
      const now = new Date();
      $("#today").textContent = now.toLocaleDateString("fr-FR",{weekday:"long",day:"numeric",month:"long",year:"numeric"});
      const base = new Date("2026-01-01");
      $("#issue").textContent = "N° " + (200 + Math.max(0,Math.floor((now-base)/86400000)));
      $("#count").textContent = `${state.articles.length} article${state.articles.length>1?"s":""}`;

      renderTopics();
      render();
      $("#loading").hidden = true;
      $("#app").hidden = false;
    }catch(err){
      $("#loading").innerHTML = `<strong>Impossible de charger l’édition.</strong><br><small>${esc(err.message)}. Ouvrez le site via GitHub Pages ou un serveur local, pas directement en file://.</small>`;
    }
  }

  init();
})();
