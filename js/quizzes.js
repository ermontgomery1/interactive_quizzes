// Quiz mode: loading questions, rendering the three question types, grading and the score.

let questions = [];

let currentIndex = 0;
let score = 0;
let answeredState = [];
let userAnswers = [];
let isCorrectState = [];

// questions.json may be a plain list, or { "title": "...", "questions": [...] }
const questionList = data => Array.isArray(data) ? data : (data && Array.isArray(data.questions) ? data.questions : null);

// Loads a quiz set (built-in folder or imported) and shows its first question
async function loadQuiz(set) {
    setMode("quiz");
    currentIndex = 0;
    score = 0;
    try {
        let data;
        if (set.imported) {
            data = JSON.parse(importedRecords.get(idFromDir(set.dir)).text);
        } else {
            const response = await fetch(set.dir + "questions.json");
            if (!response.ok) throw new Error(`HTTP ${response.status}`);
            data = await response.json();
        }
        questions = questionList(data);
        if (!questions || !questions.length) throw new Error("no questions found");
    } catch (err) {
        questions = [];
        if (set.imported) {
            document.getElementById("question-text").innerText =
                `This imported quiz couldn't be read (${err.message}). Try importing it again.`;
            return;
        }
        document.getElementById("question-text").innerText =
            `Could not load ${set.dir}questions.json (${err.message}).\n` +
            "Browsers block loading local files when the page is opened directly, so serve this folder " +
            "with a local web server instead (e.g. run `python -m http.server` here and open http://localhost:8000/interactiveQuiz.html).";
        return;
    }
    answeredState = new Array(questions.length).fill(false);
    userAnswers = new Array(questions.length).fill("");
    isCorrectState = new Array(questions.length).fill(false);
    updateScoreDisplay();
    renderNavGrid();
    loadQuestion(0);
}

// Shuffles the questions, or puts them back in id order; answers and score travel with them
function shuffleQuestions() {
    if (!questions.length) return;
    const order = shuffled
        ? randomOrder(questions.length)
        : [...questions.keys()].sort((a, b) => questions[a].id - questions[b].id);
    const reorder = arr => order.map(i => arr[i]);
    questions = reorder(questions);
    answeredState = reorder(answeredState);
    userAnswers = reorder(userAnswers);
    isCorrectState = reorder(isCorrectState);
    loadQuestion(0);
}

function matrixTable(matrix, label) {
    const rows = matrix.map(row =>
        `<tr>${row.map(v => `<td class="border border-slate-600 px-3 py-1 text-center">${escapeHtml(v)}</td>`).join("")}</tr>`
    ).join("");
    return `<div class="inline-block max-w-full mr-6 mb-3 align-top">
        <div class="text-xs text-slate-400 uppercase tracking-wider mb-1">${escapeHtml(label)}</div>
        <div class="overflow-x-auto"><table class="font-mono text-sm text-slate-200 border-collapse">${rows}</table></div>
    </div>`;
}

// Renders the optional figure description and matrices attached to a question
function renderExtras(q) {
    let html = "";
    if (q.kernel) html += matrixTable(q.kernel, "Kernel");
    if (q.input_image) html += matrixTable(q.input_image, "Input Image");
    if (q.kernels) {
        Object.entries(q.kernels).forEach(([name, m]) => { html += matrixTable(m, `Kernel (${name})`); });
    }
    if (q.images) {
        const alt = escapeHtml(q.figure || "");
        q.images.forEach(file => {
            const url = assetUrl(file);
            if (!url) {
                html += `<p class="text-sm text-rose-400 mb-3">Missing image: ${escapeHtml(file)}</p>`;
                return;
            }
            const src = escapeHtml(url);
            const img = `<img src="${src}" alt="${alt}" class="max-w-full max-h-[28rem] mb-3 rounded-lg border border-slate-700 bg-white">`;
            // An imported SVG is never opened as its own page, where it could run scripts (an <img> can't)
            html += isImportedDir(DATA_DIR) && /\.svg$/i.test(file)
                ? img
                : `<a href="${src}" target="_blank" title="Open full size">${img}</a>`;
        });
    } else if (q.figure) {
        html += `<p class="text-sm italic text-slate-400 border-l-2 border-slate-600 pl-3"><strong>Figure:</strong> ${escapeHtml(q.figure)}</p>`;
    }
    const extras = document.getElementById("question-extras");
    extras.innerHTML = html;
    extras.classList.toggle("hidden", !html);
}

function renderNavGrid() {
    const grid = document.getElementById("nav-grid");
    grid.innerHTML = "";
    questions.forEach((q, idx) => {
        const btn = document.createElement("button");
        btn.className = `w-10 h-10 sm:w-8 sm:h-8 rounded-lg text-xs font-semibold flex items-center justify-center transition border ${
            idx === currentIndex 
                ? 'border-indigo-500 bg-indigo-600 text-white' 
                : answeredState[idx] 
                    ? (isCorrectState[idx] ? 'bg-emerald-900/40 border-emerald-600 text-emerald-400' : 'bg-rose-900/40 border-rose-600 text-rose-400')
                    : 'bg-slate-900 border-slate-700 text-slate-400 hover:bg-slate-700'
        }`;
        btn.innerText = idx + 1;
        btn.title = `Original question #${q.id}`;
        btn.onclick = () => goToQuestion(idx);
        grid.appendChild(btn);
    });
}

// Short keywords (e.g. "a", "8") must stand alone so they don't match inside other words/numbers
function keywordMatches(answer, kw) {
    if (kw.length > 2) return answer.includes(kw);
    const escaped = kw.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp(`(?<![a-z0-9.])${escaped}(?![a-z0-9]|\\.\\d)`).test(answer);
}

// A multiple choice question whose "answer" is an array of letters has several correct choices
function isMultiSelect(q) {
    return q.type === 'multiple_choice' && Array.isArray(q.answer);
}

// The current selection for a multi-select question, as an array of letters
function selectedLetters(index) {
    return Array.isArray(userAnswers[index]) ? userAnswers[index] : [];
}

// Matching questions: "prompts" is a list, "answer" holds the correct choice for each prompt
// (same order), and "choices" is the shared dropdown list (defaults to the unique answers).
function matchingChoices(q) {
    return q.choices || [...new Set(q.answer)];
}

// ---------- Shuffled answers ----------
// With "Shuffle answers" on, multiple choice options and matching dropdown choices appear in a
// random order. Options are relabelled A, B, C... by position so they still read in order;
// answers are stored and graded by the original keys, so nothing else changes.
// Kept in place: True/False pairs, "all/none of the above"-style options (stay last), and any
// question with "fixed_order": true (e.g. one whose explanation refers to options by letter).
const SHUFFLE_ANSWERS_KEY = "ccn-shuffle-answers";
let shuffleAnswers = false;
try { shuffleAnswers = localStorage.getItem(SHUFFLE_ANSWERS_KEY) === "1"; } catch { /* storage unavailable */ }
let answerOrders = new WeakMap();   // question -> display order (indexes into its options/choices)
const PINNED_LAST = /^(all|none|both|neither)( of)?( the)?( above| these| options)?\.?$/i;

function answersShuffled(q) {
    return shuffleAnswers && !q.fixed_order;
}

// Display order for a list of option texts: random, except pinned options stay at the end
function answerOrder(q, texts) {
    let order = answerOrders.get(q);
    if (order && order.length === texts.length) return order;
    const lower = texts.map(t => String(t).trim().toLowerCase());
    if (lower.length === 2 && lower.includes("true") && lower.includes("false")) {
        order = lower[0] === "true" ? [0, 1] : [1, 0];   // always True, then False
    } else {
        const free = texts.map((_, i) => i).filter(i => !PINNED_LAST.test(lower[i]));
        const pinned = texts.map((_, i) => i).filter(i => PINNED_LAST.test(lower[i]));
        order = [...randomOrder(free.length).map(i => free[i]), ...pinned];
    }
    answerOrders.set(q, order);
    return order;
}

// Multiple choice option keys in the order they're shown
function displayedKeys(q) {
    const keys = Object.keys(q.options);
    return answersShuffled(q) ? answerOrder(q, Object.values(q.options)).map(i => keys[i]) : keys;
}

// The label shown for an option key: the original key in position order (A, B, C...)
function optionLabel(q, key) {
    const keys = Object.keys(q.options);
    return keys[displayedKeys(q).indexOf(key)] ?? key;
}

// Matching dropdown choices in the order they're shown
function displayedChoices(q) {
    const choices = matchingChoices(q);
    return answersShuffled(q) ? answerOrder(q, choices).map(i => choices[i]) : choices;
}

// Fresh random orders, e.g. after the setting changes or the quiz restarts
function reshuffleAnswers() {
    answerOrders = new WeakMap();
}

function updateShuffleAnswersButton() {
    const btn = document.getElementById("shuffle-answers-btn");
    btn.setAttribute("aria-pressed", String(shuffleAnswers));
    btn.classList.toggle("bg-indigo-600", shuffleAnswers);
    btn.classList.toggle("hover:bg-indigo-500", shuffleAnswers);
    btn.classList.toggle("bg-slate-700", !shuffleAnswers);
    btn.classList.toggle("hover:bg-slate-600", !shuffleAnswers);
}

function toggleShuffleAnswers() {
    shuffleAnswers = !shuffleAnswers;
    try { localStorage.setItem(SHUFFLE_ANSWERS_KEY, shuffleAnswers ? "1" : "0"); } catch { /* storage unavailable */ }
    reshuffleAnswers();
    updateShuffleAnswersButton();
    if (questions.length) loadQuestion(currentIndex);   // selections are kept: they're stored by original key
}
// ---------- End shuffled answers ----------

// The current dropdown selections for a matching question, one per prompt ("" = unselected)
function matchSelections(index) {
    const q = questions[index];
    return Array.isArray(userAnswers[index]) ? userAnswers[index] : q.prompts.map(() => "");
}

function renderMatching(index) {
    const q = questions[index];
    const container = document.getElementById("matching-container");
    const selections = matchSelections(index);
    const choices = displayedChoices(q);
    container.innerHTML = "";
    q.prompts.forEach((prompt, i) => {
        const row = document.createElement("div");
        row.className = "flex flex-col md:flex-row md:items-center gap-2 md:gap-4 p-3 rounded-lg border border-slate-700 bg-slate-900/50";
        const opts = [`<option value="">— Select —</option>`]
            .concat(choices.map(c => `<option value="${escapeHtml(c)}" ${selections[i] === c ? "selected" : ""}>${escapeHtml(c)}</option>`))
            .join("");
        row.innerHTML = `
            <span class="text-sm text-slate-200 md:flex-1"><strong>${i + 1}.</strong> ${escapeHtml(prompt)}</span>
            <select data-match-index="${i}" onchange="selectMatch(${i}, this.value)"
                class="w-full md:w-72 bg-slate-900 border border-slate-700 text-base md:text-sm rounded-md px-2 py-2 text-slate-100 focus:outline-none focus:border-indigo-500">${opts}</select>
            <span data-match-mark="${i}" class="text-xs md:w-56"></span>
        `;
        container.appendChild(row);
    });
}

function selectMatch(promptIndex, value) {
    const selections = [...matchSelections(currentIndex)];
    selections[promptIndex] = value;
    userAnswers[currentIndex] = selections;
}

// Colors each dropdown green/red after grading and shows the correct choice for wrong rows
function markMatching(index) {
    const q = questions[index];
    const selections = matchSelections(index);
    q.prompts.forEach((_, i) => {
        const select = document.querySelector(`[data-match-index="${i}"]`);
        const mark = document.querySelector(`[data-match-mark="${i}"]`);
        if (!select || !mark) return;
        const ok = selections[i] === q.answer[i];
        select.classList.remove("border-slate-700", "border-emerald-500", "border-rose-500");
        select.classList.add(ok ? "border-emerald-500" : "border-rose-500");
        mark.className = `text-xs md:w-56 ${ok ? "text-emerald-400" : "text-rose-400"}`;
        mark.innerHTML = ok ? "✓ Correct" : `✗ Correct: ${escapeHtml(q.answer[i])}`;
    });
}

function loadQuestion(index) {
    currentIndex = index;
    const q = questions[index];

    document.getElementById("question-badge").innerText = shuffled
        ? `Question ${index + 1} of ${questions.length} (original #${q.id})`
        : `Question ${q.id} of ${questions.length}`;
    const typeLabel = q.type === 'matching' ? 'Matching'
        : q.type !== 'multiple_choice' ? 'Short Answer'
        : isMultiSelect(q) ? 'Multiple Choice • Select All That Apply' : 'Multiple Choice';
    document.getElementById("question-type-badge").innerText = (q.lecture ? `${q.lecture} • ` : "") + typeLabel;
    document.getElementById("question-text").textContent = q.question;
    renderExtras(q);
    
    // Progress bar & text
    const progressPct = ((index + 1) / questions.length) * 100;
    document.getElementById("progress-bar").style.width = `${progressPct}%`;
    document.getElementById("progress-text").innerText = `Question ${index + 1} of ${questions.length}`;
    const track = document.getElementById("progress-track");
    track.setAttribute("aria-valuemax", questions.length);
    track.setAttribute("aria-valuenow", index + 1);
    track.setAttribute("aria-valuetext", `Question ${index + 1} of ${questions.length}`);

    // Reset UI elements
    document.getElementById("hint-box").classList.add("hidden");
    document.getElementById("hint-text").innerText = q.hint || "";
    // Hints are optional: hide the button (but keep its space) when there isn't one
    document.getElementById("hint-btn").classList.toggle("invisible", !q.hint);
    
    const optionsContainer = document.getElementById("options-container");
    const inputContainer = document.getElementById("input-container");
    const matchingContainer = document.getElementById("matching-container");
    matchingContainer.classList.toggle("hidden", q.type !== 'matching');

    if (q.type === 'matching') {
        optionsContainer.classList.add("hidden");
        inputContainer.classList.add("hidden");
        renderMatching(index);
    } else if (q.type === 'multiple_choice') {
        optionsContainer.classList.remove("hidden");
        inputContainer.classList.add("hidden");
        optionsContainer.innerHTML = "";
        const multi = isMultiSelect(q);
        displayedKeys(q).forEach(letter => {
            const text = q.options[letter];
            const label = optionLabel(q, letter);
            const selected = multi ? selectedLetters(index).includes(letter) : userAnswers[index] === letter;
            const div = document.createElement("label");
            div.className = `flex items-start space-x-3 p-3 rounded-lg border border-slate-700 bg-slate-900/50 hover:bg-slate-700/50 cursor-pointer transition ${
                selected ? 'border-indigo-500 bg-indigo-950/30' : ''
            }`;
            div.innerHTML = `
                <input type="${multi ? 'checkbox' : 'radio'}" name="mc-option" value="${escapeHtml(letter)}" ${selected ? 'checked' : ''} class="mt-1 text-indigo-600 focus:ring-indigo-500 bg-slate-900 border-slate-700">
                <span class="text-sm text-slate-200"><strong>${escapeHtml(label)}.</strong> ${escapeHtml(text)}</span>
            `;
            // Attached here rather than inline so the letter never has to be quoted inside JavaScript
            div.querySelector("input").addEventListener("change", e => selectMCOption(letter, e.target.checked));
            optionsContainer.appendChild(div);
        });
    } else {
        optionsContainer.classList.add("hidden");
        inputContainer.classList.remove("hidden");
        document.getElementById("user-answer").value = userAnswers[index];
    }

    // Feedback box handling
    const feedbackBox = document.getElementById("feedback-box");
    if (answeredState[index]) {
        showFeedbackUI(index);
    } else {
        feedbackBox.classList.add("hidden");
        document.getElementById("submit-btn").classList.remove("hidden");
        document.getElementById("next-btn").classList.add("hidden");
    }

    renderNavGrid();
    typesetMath();

    // On small screens "Next" sits below the fold; bring the new question's top back into view
    const card = document.getElementById("quiz-card");
    if (card.getBoundingClientRect().top < 0) card.scrollIntoView({ behavior: "smooth", block: "start" });
}

function selectMCOption(letter, checked) {
    if (isMultiSelect(questions[currentIndex])) {
        const others = selectedLetters(currentIndex).filter(l => l !== letter);
        userAnswers[currentIndex] = checked ? [...others, letter].sort() : others;
    } else {
        userAnswers[currentIndex] = letter;
    }
}

function toggleHint() {
    const hintBox = document.getElementById("hint-box");
    hintBox.classList.toggle("hidden");
}

function evaluateAnswer() {
    const q = questions[currentIndex];
    let ans = "";
    if (q.type === 'matching') {
        ans = matchSelections(currentIndex);
        if (ans.some(v => !v)) {
            alert("Please choose an answer for every prompt before submitting.");
            return;
        }
    } else if (q.type === 'multiple_choice') {
        ans = userAnswers[currentIndex];
        if (!ans || ans.length === 0) {
            alert("Please select an answer before submitting.");
            return;
        }
    } else {
        ans = document.getElementById("user-answer").value.trim();
        userAnswers[currentIndex] = ans;
        if (!ans) {
            alert("Please type an answer before submitting.");
            return;
        }
    }

    // Evaluation logic
    let correct = false;
    if (q.type === 'matching') {
        // Every prompt must be matched correctly
        correct = q.answer.every((a, i) => ans[i] === a);
    } else if (isMultiSelect(q)) {
        // All correct choices and no incorrect ones must be selected
        correct = ans.length === q.answer.length && q.answer.every(l => ans.includes(l));
    } else if (q.type === 'multiple_choice') {
        correct = ans === q.answer;
    } else {
        // Keyword match evaluation for short answer
        const lowerAns = ans.toLowerCase();
        let matchedCount = 0;
        q.keywords.forEach(kw => {
            if (keywordMatches(lowerAns, kw.toLowerCase())) {
                matchedCount++;
            }
        });
        // Threshold for keyword match
        correct = matchedCount >= Math.min(1, q.keywords.length) && (q.keywords.length === 0 || matchedCount > 0);
        
        // Special check for exact numbers or formulas
        q.keywords.forEach(kw => {
            if (lowerAns === kw.toLowerCase()) {
                correct = true;
            }
        });
    }

    if (!answeredState[currentIndex]) {
        answeredState[currentIndex] = true;
        isCorrectState[currentIndex] = correct;
        if (correct) {
            score++;
        }
    } else {
        // If re-evaluating
        if (isCorrectState[currentIndex] !== correct) {
            if (correct) score++; else score--;
            isCorrectState[currentIndex] = correct;
        }
    }

    updateScoreDisplay();
    showFeedbackUI(currentIndex);
    renderNavGrid();
}

function showFeedbackUI(index) {
    const q = questions[index];
    const correct = isCorrectState[index];
    const feedbackBox = document.getElementById("feedback-box");
    const feedbackHeader = document.getElementById("feedback-header");
    const feedbackExplanation = document.getElementById("feedback-explanation");

    feedbackBox.classList.remove("hidden");
    if (correct) {
        feedbackBox.className = "mb-6 p-5 rounded-lg border bg-emerald-950/30 border-emerald-600/30 text-sm";
        feedbackHeader.className = "flex items-center space-x-2 font-semibold mb-2 text-emerald-400";
        feedbackHeader.innerHTML = `
            <svg class="w-5 h-5 text-emerald-400" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 13l4 4L19 7"></path></svg>
            <span>Correct! Excellent work.</span>
        `;
    } else {
        feedbackBox.className = "mb-6 p-5 rounded-lg border bg-rose-950/30 border-rose-600/30 text-sm";
        feedbackHeader.className = "flex items-center space-x-2 font-semibold mb-2 text-rose-400";
        feedbackHeader.innerHTML = `
            <svg class="w-5 h-5 text-rose-400" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12"></path></svg>
            <span>Incorrect or Incomplete.</span>
        `;
    }

    if (q.type === 'matching') markMatching(index);

    let sampleText = q.type === 'matching'
        ? `<br><br><strong>Correct Matches:</strong><br>${q.prompts.map((p, i) => `${i + 1}. ${escapeHtml(p)} &rarr; <strong>${escapeHtml(q.answer[i])}</strong>`).join("<br>")}`
        : isMultiSelect(q)
        ? `<br><br><strong>Correct Answers:</strong><br>${displayedKeys(q).filter(l => q.answer.includes(l))
            .map(l => `${escapeHtml(optionLabel(q, l))}. ${escapeHtml(q.options[l])}`).join("<br>")}`
        : q.type === 'multiple_choice'
            ? `<br><br><strong>Correct Answer:</strong> ${escapeHtml(optionLabel(q, q.answer))}. ${escapeHtml(q.options[q.answer])}`
            : `<br><br><strong>Sample Correct Answer:</strong> ${escapeHtml(q.answer)}`;
    // Explanations are optional
    feedbackExplanation.innerHTML = q.explanation
        ? `<strong>Explanation:</strong> ${escapeHtml(q.explanation)}${sampleText}`
        : sampleText.replace(/^<br><br>/, "");

    document.getElementById("submit-btn").classList.add("hidden");
    document.getElementById("next-btn").classList.remove("hidden");

    typesetMath();
}

function updateScoreDisplay() {
    document.getElementById("score-display").innerText = `Score: ${score} / ${questions.length}`;
}

function nextQuestion() {
    if (currentIndex < questions.length - 1) {
        loadQuestion(currentIndex + 1);
    } else {
        alert(`Quiz completed! Your final score is ${score} out of ${questions.length}.`);
    }
}

function goToQuestion(index) {
    loadQuestion(index);
}

function restartQuiz() {
    if (confirm("Are you sure you want to reset your quiz progress?")) {
        reshuffleAnswers();
        currentIndex = 0;
        score = 0;
        answeredState.fill(false);
        userAnswers.fill("");
        isCorrectState.fill(false);
        updateScoreDisplay();
        loadQuestion(0);
    }
}
