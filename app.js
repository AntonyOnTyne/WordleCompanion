(() => {
  "use strict";

  const ROW_COUNT = 5;
  const WORD_LENGTH = 5;
  const STATUS_ORDER = ["gray", "mustard", "green"];
  const STATUS_PRIORITY = { gray: 1, mustard: 2, green: 3 };
  const STATUS_LABEL = {
    gray: "not in the word",
    mustard: "in the word, different position",
    green: "correct position"
  };
  const KEYBOARD_ROWS = [
    ["Q", "W", "E", "R", "T", "Y", "U", "I", "O", "P"],
    ["A", "S", "D", "F", "G", "H", "J", "K", "L"],
    ["ENTER", "Z", "X", "C", "V", "B", "N", "M", "BACKSPACE"]
  ];

  const app = document.getElementById("app");
  const boardElement = document.getElementById("board");
  const keyboardElement = document.getElementById("keyboard");
  const dictionaryStatus = document.getElementById("dictionary-status");
  const helpToggleButton = document.getElementById("help-toggle");
  const instructionsBackdrop = document.getElementById("instructions-backdrop");
  const instructionsPanel = document.getElementById("instructions-panel");
  const instructionsCloseButton = document.getElementById("instructions-close");
  const informationMessage = document.getElementById("information-message");
  const toggleWordsButton = document.getElementById("toggle-words");
  const wordListElement = document.getElementById("word-list");
  const gameStatus = document.getElementById("game-status");
  const clipboardFallback = document.getElementById("clipboard-fallback");
  const clipboardWord = document.getElementById("clipboard-word");
  const resetButton = document.getElementById("reset-button");
  const toast = document.getElementById("toast");

  let dictionary = [];
  let dictionarySet = new Set();
  let candidates = [];
  let rows = [];
  let activeRowIndex = 0;
  let loaded = false;
  let wordsVisible = false;
  let instructionsOpen = false;
  let instructionsReturnFocus = null;
  let pinchHandlersAttached = false;
  let toastTimer = 0;
  let shakeTimer = 0;

  function makeEmptyRows() {
    return Array.from({ length: ROW_COUNT }, (_, index) => ({
      word: "",
      feedback: Array(WORD_LENGTH).fill("gray"),
      lockedTiles: Array(WORD_LENGTH).fill(false),
      phase: index === 0 ? "input" : "empty"
    }));
  }

  function buildKeyboard() {
    keyboardElement.replaceChildren();

    KEYBOARD_ROWS.forEach((rowKeys, rowIndex) => {
      const row = document.createElement("div");
      row.className = "keyboard-row";

      rowKeys.forEach((key) => {
        const button = document.createElement("button");
        button.type = "button";
        button.className = "key";

        if (key === "ENTER") {
          button.dataset.key = "Enter";
          button.classList.add("key-wide");
          button.textContent = "Enter";
          button.setAttribute("aria-label", "Enter or confirm row");
        } else if (key === "BACKSPACE") {
          button.dataset.key = "Backspace";
          button.classList.add("key-wide");
          button.textContent = "⌫";
          button.setAttribute("aria-label", "Backspace");
        } else {
          button.dataset.key = key;
          button.textContent = key;
          button.setAttribute("aria-label", key);
        }

        button.addEventListener("click", () => handleKey(button.dataset.key));
        row.append(button);
      });

      row.dataset.row = String(rowIndex + 1);
      keyboardElement.append(row);
    });
  }

  function randomizeBrandLetters() {
    const letters = "ABCDEFGHIJKLMNOPQRSTUVWXYZ".split("");
    document.querySelectorAll(".brand-mark i").forEach((tile) => {
      const index = Math.floor(Math.random() * letters.length);
      tile.textContent = letters.splice(index, 1)[0];
    });
  }

  function triggerHaptic() {
    if (typeof navigator.vibrate !== "function") return;
    try {
      navigator.vibrate(10);
    } catch {
      // Vibration is optional and may be blocked by the browser or device.
    }
  }

  function isGameplayActive() {
    return loaded && !instructionsOpen;
  }

  function preventMultiTouchZoom(event) {
    if (isGameplayActive() && event.touches?.length > 1 && event.cancelable) {
      event.preventDefault();
    }
  }

  function preventSafariGestureZoom(event) {
    if (isGameplayActive() && event.cancelable) event.preventDefault();
  }

  function syncGameplayTouchAction() {
    const active = isGameplayActive();
    document.documentElement.classList.toggle("gameplay-active", active);

    if (active && !pinchHandlersAttached) {
      document.addEventListener("touchmove", preventMultiTouchZoom, { passive: false });
      document.addEventListener("gesturestart", preventSafariGestureZoom, { passive: false });
      document.addEventListener("gesturechange", preventSafariGestureZoom, { passive: false });
      pinchHandlersAttached = true;
    } else if (!active && pinchHandlersAttached) {
      document.removeEventListener("touchmove", preventMultiTouchZoom);
      document.removeEventListener("gesturestart", preventSafariGestureZoom);
      document.removeEventListener("gesturechange", preventSafariGestureZoom);
      pinchHandlersAttached = false;
    }
  }

  function scoreGuess(answer, guess) {
    const feedback = Array(WORD_LENGTH).fill("gray");
    const remaining = new Map();

    for (let index = 0; index < WORD_LENGTH; index += 1) {
      if (guess[index] === answer[index]) {
        feedback[index] = "green";
      } else {
        remaining.set(answer[index], (remaining.get(answer[index]) || 0) + 1);
      }
    }

    for (let index = 0; index < WORD_LENGTH; index += 1) {
      if (feedback[index] === "green") continue;

      const count = remaining.get(guess[index]) || 0;
      if (count > 0) {
        feedback[index] = "mustard";
        remaining.set(guess[index], count - 1);
      }
    }

    return feedback;
  }

  function getConstrainedRows() {
    return rows.filter((row) => row.phase === "check" || row.phase === "confirmed");
  }

  function inheritedStatus(rowIndex, tileIndex, letter = rows[rowIndex]?.word[tileIndex]) {
    if (!letter) return null;

    let inherited = null;
    for (let previousIndex = 0; previousIndex < rowIndex; previousIndex += 1) {
      const previousRow = rows[previousIndex];
      if (previousRow.phase !== "check" && previousRow.phase !== "confirmed") continue;
      if (previousRow.word[tileIndex] !== letter) continue;

      const status = previousRow.feedback[tileIndex];
      if (STATUS_PRIORITY[status] &&
          (!inherited || STATUS_PRIORITY[status] > STATUS_PRIORITY[inherited])) {
        inherited = status;
      }
    }

    return inherited;
  }

  function fitsAllClues(answer) {
    return getConstrainedRows().every((row) => {
      const actual = scoreGuess(answer, row.word);
      return actual.every((status, index) => status === row.feedback[index]);
    });
  }

  function getKeyboardStatuses() {
    const best = new Map();

    for (const row of getConstrainedRows()) {
      for (let index = 0; index < WORD_LENGTH; index += 1) {
        const letter = row.word[index];
        const status = row.feedback[index];
        if (!letter) continue;

        const oldStatus = best.get(letter);
        if (!oldStatus || STATUS_PRIORITY[status] > STATUS_PRIORITY[oldStatus]) {
          best.set(letter, status);
        }
      }
    }

    return best;
  }

  function renderBoard() {
    boardElement.replaceChildren();

    rows.forEach((row, rowIndex) => {
      const rowElement = document.createElement("div");
      rowElement.className = "guess-row";
      rowElement.setAttribute("role", "group");
      rowElement.setAttribute("aria-label", `Guess row ${rowIndex + 1}${row.phase === "check" ? ", edit tile colours" : ""}`);
      rowElement.dataset.rowIndex = String(rowIndex);

      if (rowIndex === activeRowIndex && row.phase === "input") rowElement.classList.add("is-active");

      for (let tileIndex = 0; tileIndex < WORD_LENGTH; tileIndex += 1) {
        const tile = document.createElement("button");
        const letter = row.word[tileIndex] || "";
        const canChange = row.phase === "check";
        const isLocked = canChange && row.lockedTiles[tileIndex];
        tile.type = "button";
        tile.className = "tile";
        tile.textContent = letter;
        tile.disabled = !canChange;
        tile.setAttribute("aria-disabled", String(isLocked));
        if (isLocked) {
          tile.classList.add("is-locked");
          tile.title = "Inherited from an earlier row and locked";
        }
        tile.setAttribute("aria-label", `Row ${rowIndex + 1}, tile ${tileIndex + 1}${letter ? `, ${letter}` : ""}${row.phase === "check" || row.phase === "confirmed" ? `, ${STATUS_LABEL[row.feedback[tileIndex]]}` : ""}${isLocked ? ", inherited and locked from an earlier row" : canChange ? ", tap to change clue" : ""}`);

        if (letter) tile.classList.add("has-letter");
        if (rowIndex === activeRowIndex && row.phase === "input") tile.classList.add("is-active");
        if (canChange || row.phase === "confirmed") {
          tile.classList.add("is-checked", `is-${row.feedback[tileIndex]}`);
        }

        if (canChange) {
          tile.addEventListener("click", () => {
            triggerHaptic();
            cycleTile(rowIndex, tileIndex);
          });
        }

        rowElement.append(tile);
      }

      boardElement.append(rowElement);
    });
  }

  function renderKeyboard() {
    const statuses = getKeyboardStatuses();
    const keyboardButtons = keyboardElement.querySelectorAll(".key");

    keyboardButtons.forEach((button) => {
      button.classList.remove("key-gray", "key-mustard", "key-green");
      const key = button.dataset.key;
      const status = statuses.get(key);
      if (status) button.classList.add(`key-${status}`);
      button.disabled = !loaded || activeRowIndex === null;
    });
  }

  function canChooseCandidate() {
    return loaded;
  }

  function renderWordList() {
    wordListElement.replaceChildren();
    const sortedWords = [...candidates].sort();

    if (sortedWords.length === 0) {
      const empty = document.createElement("p");
      empty.className = "empty-candidates";
      empty.textContent = "No words match these clues. Check the tile colours.";
      wordListElement.append(empty);
      return;
    }

    const fragment = document.createDocumentFragment();
    const canChoose = canChooseCandidate();

    sortedWords.forEach((word) => {
      const entry = document.createElement("div");
      entry.className = "candidate-entry";
      entry.setAttribute("role", "listitem");

      const button = document.createElement("button");
      button.type = "button";
      button.className = "candidate-word";
      button.textContent = word;
      button.disabled = !canChoose;
      const copiesWord = activeRowIndex === null ||
        (activeRowIndex === ROW_COUNT - 1 && rows[activeRowIndex].phase === "check");
      button.setAttribute("aria-label", copiesWord
        ? `Copy ${word} for your sixth Wordle guess`
        : `Select ${word} and submit it as your next companion guess`);
      button.addEventListener("click", () => selectCandidate(word));
      entry.append(button);
      fragment.append(entry);
    });

    wordListElement.append(fragment);
  }

  function renderInformation() {
    toggleWordsButton.disabled = !loaded;
    toggleWordsButton.textContent = wordsVisible ? "Hide words" : "Show words";
    toggleWordsButton.setAttribute("aria-expanded", String(wordsVisible));
    wordListElement.hidden = !wordsVisible;

    if (!loaded) return;

    const submitted = getConstrainedRows().length > 0;
    if (!submitted) {
      informationMessage.textContent = `I have ${dictionary.length.toLocaleString("en-GB")} five-letter words in my dictionary. All of them are possible Wordle answers.`;
    } else {
      const eliminated = dictionary.length - candidates.length;
      informationMessage.textContent = `I have eliminated ${eliminated.toLocaleString("en-GB")} possible words; ${candidates.length.toLocaleString("en-GB")} words remain.`;
    }

    if (wordsVisible) renderWordList();
  }

  function updateApp() {
    clipboardFallback.hidden = true;
    clipboardWord.textContent = "";
    if (loaded) candidates = dictionary.filter(fitsAllClues);
    renderBoard();
    renderKeyboard();
    renderInformation();
  }

  function showToast(message, shakeRowIndex = null) {
    window.clearTimeout(toastTimer);
    toast.textContent = message;
    toast.hidden = false;

    if (shakeRowIndex !== null) {
      window.clearTimeout(shakeTimer);
      const rowElement = boardElement.querySelector(`[data-row-index="${shakeRowIndex}"]`);
      if (rowElement) {
        rowElement.classList.remove("is-shaking");
        void rowElement.offsetWidth;
        rowElement.classList.add("is-shaking");
        shakeTimer = window.setTimeout(() => rowElement.classList.remove("is-shaking"), 520);
      }
    }

    toastTimer = window.setTimeout(() => {
      toast.hidden = true;
      toast.textContent = "";
    }, 3000);
  }

  function setGameStatus(message) {
    gameStatus.textContent = message;
  }

  function hasSeenInstructions() {
    try {
      return window.localStorage.getItem("wordleCompanionInstructionsSeen") === "true";
    } catch {
      return false;
    }
  }

  function markInstructionsSeen() {
    try {
      window.localStorage.setItem("wordleCompanionInstructionsSeen", "true");
    } catch {
      // The instructions remain available from the help button if storage is unavailable.
    }
  }

  function openInstructions(returnFocusTo = helpToggleButton) {
    if (instructionsOpen) return;

    instructionsReturnFocus = returnFocusTo instanceof HTMLElement ? returnFocusTo : helpToggleButton;
    instructionsOpen = true;
    instructionsBackdrop.hidden = false;
    app.inert = true;
    app.setAttribute("aria-hidden", "true");
    document.body.classList.add("modal-open");
    helpToggleButton.setAttribute("aria-expanded", "true");
    syncGameplayTouchAction();
    instructionsPanel.focus();
  }

  function closeInstructions() {
    if (!instructionsOpen) return;

    instructionsOpen = false;
    instructionsBackdrop.hidden = true;
    app.inert = false;
    app.removeAttribute("aria-hidden");
    document.body.classList.remove("modal-open");
    helpToggleButton.setAttribute("aria-expanded", "false");
    syncGameplayTouchAction();
    markInstructionsSeen();

    const focusTarget = instructionsReturnFocus?.isConnected ? instructionsReturnFocus : helpToggleButton;
    focusTarget.focus();
    instructionsReturnFocus = null;
  }

  function trapInstructionsKeyboard(event) {
    if (!instructionsOpen) return;

    if (event.key === "Escape") {
      event.preventDefault();
      event.stopImmediatePropagation();
      closeInstructions();
      return;
    }

    if (event.key === "Tab") {
      const focusable = [...instructionsPanel.querySelectorAll("button:not(:disabled), a[href], [tabindex]:not([tabindex='-1'])")];
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      const active = document.activeElement;

      if (!first) {
        event.preventDefault();
        instructionsPanel.focus();
      } else if (active === instructionsPanel || !instructionsPanel.contains(active)) {
        event.preventDefault();
        (event.shiftKey ? last : first).focus();
      } else if (event.shiftKey && active === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && active === last) {
        event.preventDefault();
        first.focus();
      }

      event.stopImmediatePropagation();
      return;
    }

    if ((event.key === "Enter" || event.key === " ") &&
        event.target instanceof HTMLElement && event.target.closest("button")) {
      return;
    }

    event.preventDefault();
    event.stopImmediatePropagation();
  }

  function submitGuess() {
    if (!loaded || activeRowIndex === null) return false;
    const row = rows[activeRowIndex];

    if (row.phase !== "input") return false;
    if (row.word.length !== WORD_LENGTH) {
      showToast("Enter a five-letter word.", activeRowIndex);
      return false;
    }

    if (!dictionarySet.has(row.word)) {
      showToast("Word not in my dictionary", activeRowIndex);
      return false;
    }

    window.clearTimeout(toastTimer);
    toast.hidden = true;
    toast.textContent = "";
    const earlierCandidates = candidates;
    row.feedback = Array.from({ length: WORD_LENGTH }, (_, index) => {
      const inherited = inheritedStatus(activeRowIndex, index, row.word[index]);
      return inherited || "gray";
    });
    row.lockedTiles = Array.from({ length: WORD_LENGTH }, (_, index) => {
      const inherited = inheritedStatus(activeRowIndex, index, row.word[index]);
      if (!inherited || earlierCandidates.length === 0) return false;

      return earlierCandidates.every((answer) => scoreGuess(answer, row.word)[index] === inherited);
    });
    row.phase = "check";
    setGameStatus("Tap each tile to match the clues from your Wordle game, then press Enter to continue.");
    updateApp();
    return true;
  }

  function confirmAndAdvance() {
    if (!loaded || activeRowIndex === null) return false;
    const currentRow = rows[activeRowIndex];
    if (currentRow.phase !== "check") return false;

    currentRow.phase = "confirmed";

    if (activeRowIndex === ROW_COUNT - 1) {
      activeRowIndex = null;
      setGameStatus("Five companion rows are complete. Use a remaining word for your sixth Wordle guess.");
    } else {
      activeRowIndex += 1;
      rows[activeRowIndex].phase = "input";
      setGameStatus(`Row ${activeRowIndex + 1} is ready.`);
    }

    updateApp();
    return true;
  }

  function addLetter(letter) {
    if (!loaded || activeRowIndex === null) return;

    if (rows[activeRowIndex].phase === "check") {
      if (activeRowIndex === ROW_COUNT - 1) {
        showToast("Five rows are complete. Tap a remaining word to copy it for your sixth Wordle guess.");
        return;
      }
      confirmAndAdvance();
    }

    if (activeRowIndex === null) return;
    const row = rows[activeRowIndex];
    if (row.phase !== "input" || row.word.length >= WORD_LENGTH) return;

    row.word += letter;
    setGameStatus("");
    updateApp();
  }

  function deleteLetter() {
    if (!loaded || activeRowIndex === null) return;
    const row = rows[activeRowIndex];
    if (row.phase !== "input" || row.word.length === 0) return;

    row.word = row.word.slice(0, -1);
    setGameStatus("");
    updateApp();
  }

  function handleKey(key) {
    if (loaded && activeRowIndex !== null) triggerHaptic();

    if (key === "Enter") {
      if (activeRowIndex === null) return;
      if (rows[activeRowIndex].phase === "input") submitGuess();
      else confirmAndAdvance();
      return;
    }

    if (key === "Backspace") {
      deleteLetter();
      return;
    }

    if (/^[A-Z]$/.test(key)) addLetter(key);
  }

  function cycleTile(rowIndex, tileIndex) {
    const row = rows[rowIndex];
    if (row.phase !== "check" || row.lockedTiles[tileIndex]) return;

    const current = row.feedback[tileIndex];
    const currentIndex = STATUS_ORDER.indexOf(current);
    row.feedback[tileIndex] = STATUS_ORDER[(currentIndex + 1) % STATUS_ORDER.length];
    updateApp();
  }

  async function copyCandidate(word) {
    try {
      if (typeof navigator.clipboard?.writeText !== "function") throw new Error("Clipboard is unavailable.");
      await navigator.clipboard.writeText(word);
      showToast(`Copied ${word}. Paste it as your sixth Wordle guess.`);
    } catch {
      clipboardWord.textContent = word;
      clipboardFallback.hidden = false;
      setGameStatus("");
    }
  }

  async function selectCandidate(word) {
    if (!canChooseCandidate() || !dictionarySet.has(word)) return;

    const finalRowInCheck = activeRowIndex === ROW_COUNT - 1 && rows[activeRowIndex].phase === "check";
    if (activeRowIndex === null || finalRowInCheck) {
      await copyCandidate(word);
      return;
    }

    if (rows[activeRowIndex].phase === "check") {
      confirmAndAdvance();
      if (activeRowIndex === null) return;
    }

    const row = rows[activeRowIndex];
    row.phase = "input";
    row.word = word;
    setGameStatus("");
    updateApp();
    submitGuess();
  }

  function resetGame() {
    if (!loaded) return;
    window.clearTimeout(toastTimer);
    toast.hidden = true;
    toast.textContent = "";
    rows = makeEmptyRows();
    activeRowIndex = 0;
    wordsVisible = false;
    clipboardFallback.hidden = true;
    clipboardWord.textContent = "";
    setGameStatus("Enter a five-letter word to begin.");
    updateApp();
  }

  function parseDictionary(text) {
    const words = [];
    const seen = new Set();

    for (const rawLine of text.split(/\r?\n/)) {
      const word = rawLine.trim().toUpperCase();
      if (!/^[A-Z]{5}$/.test(word) || seen.has(word)) continue;
      seen.add(word);
      words.push(word);
    }

    return words;
  }

  async function loadDictionary() {
    try {
      const response = await fetch("./words.txt", { cache: "no-store" });
      if (!response.ok) throw new Error(`Could not load words.txt (${response.status}).`);

      const text = await response.text();
      dictionary = parseDictionary(text);
      if (dictionary.length === 0) throw new Error("words.txt did not contain any five-letter words.");

      dictionarySet = new Set(dictionary);
      candidates = [...dictionary];
      rows = makeEmptyRows();
      activeRowIndex = 0;
      loaded = true;
      app.setAttribute("aria-busy", "false");
      syncGameplayTouchAction();
      dictionaryStatus.textContent = `${dictionary.length.toLocaleString("en-GB")} words loaded`;
      resetButton.disabled = false;
      setGameStatus("Enter a five-letter word to begin.");
      updateApp();
    } catch (error) {
      console.error(error);
      app.setAttribute("aria-busy", "false");
      dictionaryStatus.textContent = "Dictionary unavailable";
      informationMessage.textContent = "The app couldn’t load words.txt. Keep it alongside index.html and open the app through your deployed site or a local web server.";
      setGameStatus("Reload the page after correcting the word-list location.");
      renderBoard();
      renderKeyboard();
    }
  }

  toggleWordsButton.addEventListener("click", () => {
    if (!loaded) return;
    triggerHaptic();
    wordsVisible = !wordsVisible;
    renderInformation();
  });

  helpToggleButton.addEventListener("click", () => openInstructions(helpToggleButton));
  instructionsCloseButton.addEventListener("click", closeInstructions);
  document.addEventListener("keydown", trapInstructionsKeyboard, true);
  resetButton.addEventListener("click", () => {
    triggerHaptic();
    resetGame();
  });

  document.addEventListener("keydown", (event) => {
    if (event.altKey || event.ctrlKey || event.metaKey) return;

    const target = event.target;
    const isEditable = target instanceof HTMLElement && (
      target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName)
    );
    if (isEditable) return;

    if (event.key === "Enter") {
      if (target instanceof HTMLElement && target.closest("button, a")) return;
      event.preventDefault();
      handleKey("Enter");
      return;
    }

    if (event.key === "Backspace") {
      event.preventDefault();
      handleKey("Backspace");
      return;
    }

    if (/^[a-z]$/i.test(event.key)) {
      event.preventDefault();
      handleKey(event.key.toUpperCase());
    }
  });

  rows = makeEmptyRows();
  randomizeBrandLetters();
  buildKeyboard();
  renderBoard();
  if (!hasSeenInstructions()) openInstructions(helpToggleButton);
  loadDictionary();
})();
