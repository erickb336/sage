(function () {
  "use strict";
  var DATA = JSON.parse(document.getElementById("data").textContent);
  var KEY = "sage-t573-principles-review-v1";
  var state = { marks: {}, answers: {} };
  var copiedText = null, undo = null, clearArmed = false;
  var $ = function (id) { return document.getElementById(id); };
  var byOld = {};
  DATA.rows.forEach(function (r) { byOld[r.old] = r; });

  // ---- Memory. Browser storage can be blocked; the page then still works, and says so.
  function warnStorage() { $("storage-warning").hidden = false; }
  function load() {
    try {
      var raw = localStorage.getItem(KEY);
      if (!raw) return;
      var s = JSON.parse(raw);
      if (s && typeof s === "object") {
        Object.keys(s.marks || {}).forEach(function (old) {
          var m = s.marks[old];
          if (byOld[old] && m && ["keep", "change", "drop"].indexOf(m.mark) >= 0) state.marks[old] = { mark: m.mark, note: String(m.note || "") };
        });
        DATA.questions.forEach(function (q) { var a = (s.answers || {})[q.id]; if (a && q.options[a]) state.answers[q.id] = a; });
      }
    } catch (e) { warnStorage(); }
  }
  function save() {
    try { localStorage.setItem(KEY, JSON.stringify(state)); } catch (e) { warnStorage(); }
  }

  // ---- What each mark means for this row.
  function effect(r, mark) {
    if (mark === "keep") {
      if (r.action === "merge") return "It goes into " + r.targetName + ".";
      if (r.action === "split") return "Its parts go to " + r.parts.join(", ") + ".";
      if (r.action === "keep") return "The text stays as " + r.name + ".";
      return "The new text goes in as " + r.name + ".";
    }
    if (mark === "change") return "Write what you want below.";
    if (r.action === "merge" || r.action === "split") return "Its ideas do not move. The principle ends here.";
    var more = r.incoming ? " " + r.incoming + (r.incoming === 1 ? " other row goes" : " other rows go") + " into this one, so the chief will ask where they go." : "";
    return r.name + " leaves sage." + more;
  }
  function actionWords(r) {
    if (r.action === "merge") return "merge into " + r.targetName;
    if (r.action === "split") return "split into " + r.parts.join(", ");
    if (r.action === "keep") return "keep as " + r.name;
    return "rewrite as " + r.name;
  }

  // ---- The text to paste back.
  function buildText() {
    var c = { keep: 0, change: 0, drop: 0 }, marked = 0;
    var lines = DATA.rows.map(function (r) {
      var m = state.marks[r.old];
      if (m) { c[m.mark]++; marked++; }
      var line = r.n + " " + r.old + " (" + actionWords(r) + "): " + (m ? m.mark : "not marked");
      if (m && m.mark === "change") line += m.note.trim() ? ": " + m.note.trim().replace(/\s*\n\s*/g, " / ") : ": no note";
      return line;
    });
    var answers = DATA.questions.map(function (q) {
      var a = state.answers[q.id];
      return q.id + " " + q.text + " " + (a ? a + ". " + q.options[a] : "not answered");
    });
    return ["T573 principle review, " + DATA.version,
      "Marked " + marked + " of " + DATA.rows.length + ": keep " + c.keep + ", change " + c.change + ", drop " + c.drop + ".",
      ""].concat(lines, ["", "Questions"], answers).join("\n");
  }

  // ---- Show the state.
  function paintRow(tr) {
    var r = byOld[tr.dataset.old], m = state.marks[r.old], mark = m ? m.mark : "";
    if (mark) tr.dataset.mark = mark; else delete tr.dataset.mark;
    tr.querySelectorAll(".mark").forEach(function (b) { b.setAttribute("aria-pressed", String(b.dataset.mark === mark)); });
    tr.querySelector(".effect").textContent = mark ? effect(r, mark) : "";
    var note = tr.querySelector(".note"), ta = note.querySelector("textarea");
    note.hidden = mark !== "change";
    if (mark === "change" && document.activeElement !== ta) ta.value = m.note;
  }
  function paintQuestions() {
    document.querySelectorAll(".q").forEach(function (f) {
      f.querySelectorAll(".opt").forEach(function (b) { b.setAttribute("aria-pressed", String(state.answers[f.dataset.q] === b.dataset.opt)); });
    });
  }
  function paintSummary() {
    var marked = Object.keys(state.marks).length, total = DATA.rows.length;
    var answered = Object.keys(state.answers).length, qs = DATA.questions.length;
    var noNote = Object.keys(state.marks).filter(function (o) { var m = state.marks[o]; return m.mark === "change" && !m.note.trim(); }).length;
    $("count").textContent = marked + " of " + total + " rows marked";
    $("meter-fill").style.width = (100 * marked / total) + "%";
    var text = buildText();
    $("copy-text").value = text;
    var line;
    if (marked === 0 && answered === 0) line = "You have no marks yet. Start at row 1. The copied text shows each row as not marked.";
    else if (marked < total || answered < qs) line = (total - marked) + " rows and " + (qs - answered) + " questions are still open. You can copy now and send the rest later.";
    else line = "All rows and questions have your answer. Copy the text, then paste it in the chat.";
    if (noNote) line += " " + noNote + (noNote === 1 ? " Change mark has" : " Change marks have") + " no note yet.";
    $("finish-line").textContent = line;
    if (copiedText !== null && copiedText !== text && !$("status").querySelector("button")) status("You changed a mark after the last copy. Copy again before you paste.", "");
  }
  function paintAll() {
    document.querySelectorAll("tr[data-old]").forEach(paintRow);
    paintQuestions();
    paintSummary();
  }
  function status(text, kind, action) {
    var s = $("status");
    s.textContent = text;
    s.className = "status" + (kind ? " " + kind : "");
    if (action) {
      var b = document.createElement("button");
      b.type = "button"; b.className = "linkish"; b.textContent = action.label;
      b.addEventListener("click", action.run);
      s.appendChild(b);
    }
  }

  // ---- Filters.
  var filter = "all";
  function applyFilter() {
    var shown = 0;
    document.querySelectorAll("tbody").forEach(function (tb) {
      var inGroup = 0;
      tb.querySelectorAll("tr[data-old]").forEach(function (tr) {
        var show = filter === "all" || (filter === "open" && !state.marks[tr.dataset.old]) || (filter === "moved" && (tr.dataset.action === "merge" || tr.dataset.action === "split"));
        tr.hidden = !show;
        if (show) inGroup++;
      });
      tb.querySelector(".group").hidden = !inGroup;
      shown += inGroup;
    });
    var e = $("empty");
    e.hidden = shown > 0;
    e.textContent = "Each row has a mark. Choose All rows to see them, or copy your choices.";
    document.querySelector("table").hidden = shown === 0;
  }
  document.querySelectorAll(".chip").forEach(function (c) {
    c.addEventListener("click", function () {
      filter = c.dataset.filter;
      document.querySelectorAll(".chip").forEach(function (x) { x.setAttribute("aria-pressed", String(x === c)); });
      applyFilter();
    });
  });

  // ---- Marks, notes and answers.
  document.querySelector("table").addEventListener("click", function (e) {
    var b = e.target.closest ? e.target.closest(".mark") : null;
    if (!b) return;
    var tr = b.closest("tr"), old = tr.dataset.old, cur = state.marks[old];
    if (cur && cur.mark === b.dataset.mark) delete state.marks[old];
    else state.marks[old] = { mark: b.dataset.mark, note: cur ? cur.note : "" };
    save(); paintRow(tr); paintSummary();
    if (state.marks[old] && state.marks[old].mark === "change") tr.querySelector(".note textarea").focus();
  });
  document.querySelector("table").addEventListener("input", function (e) {
    if (e.target.tagName !== "TEXTAREA") return;
    var old = e.target.closest("tr").dataset.old;
    if (state.marks[old]) { state.marks[old].note = e.target.value; save(); paintSummary(); }
  });
  document.querySelectorAll(".q").forEach(function (f) {
    f.addEventListener("click", function (e) {
      var b = e.target.closest ? e.target.closest(".opt") : null;
      if (!b) return;
      if (state.answers[f.dataset.q] === b.dataset.opt) delete state.answers[f.dataset.q];
      else state.answers[f.dataset.q] = b.dataset.opt;
      save(); paintQuestions(); paintSummary();
    });
  });

  // ---- Copy. The clipboard can refuse a page that opens from a file, so the page has two fallbacks.
  function copied(text) {
    copiedText = text;
    var marked = Object.keys(state.marks).length, open = DATA.rows.length - marked;
    status("Copied " + marked + " marks." + (open ? " " + open + " rows have no mark." : "") + " Paste the text in the chat.", "good");
  }
  function byHand(text) {
    var t = $("copy-text");
    $("preview").open = true;
    t.focus();
    t.select();
    var ok = false;
    try { ok = document.execCommand("copy"); } catch (e) { ok = false; }
    if (ok) copied(text);
    else status("This browser refused the copy. The text below is selected: copy it by hand.", "bad");
  }
  function copy() {
    var text = buildText();
    $("copy-text").value = text;
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text).then(function () { copied(text); }, function () { byHand(text); });
    else byHand(text);
  }
  $("copy").addEventListener("click", copy);
  $("copy2").addEventListener("click", copy);

  // ---- Clear, in two presses, with an undo.
  $("clear").addEventListener("click", function () {
    var b = $("clear");
    if (!clearArmed) {
      clearArmed = true;
      b.textContent = "Press again to clear all";
      b.classList.add("danger");
      setTimeout(function () { clearArmed = false; b.textContent = "Clear all marks"; b.classList.remove("danger"); }, 4000);
      return;
    }
    clearArmed = false;
    b.textContent = "Clear all marks";
    b.classList.remove("danger");
    undo = JSON.stringify(state);
    state = { marks: {}, answers: {} };
    save(); paintAll(); applyFilter();
    status("You cleared all marks.", "", { label: "Undo", run: function () {
      state = JSON.parse(undo);
      save(); status("", ""); paintAll(); applyFilter();
    } });
  });

  // ---- At a narrow width the old text starts closed, so that the new text comes first.
  var wide = window.matchMedia("(min-width:1000px)");
  function setOld() { document.querySelectorAll(".oldtext").forEach(function (d) { d.open = wide.matches; }); }
  if (wide.addEventListener) wide.addEventListener("change", setOld);
  setOld();

  // ---- The sticky bar height keeps the table header and the marks under it.
  function setBar() { document.documentElement.style.setProperty("--bar-h", $("bar").offsetHeight + "px"); }
  window.addEventListener("resize", setBar);
  new MutationObserver(setBar).observe($("status"), { childList: true, characterData: true, subtree: true });
  setBar();

  load();
  paintAll();
  applyFilter();
  setBar();
})();
