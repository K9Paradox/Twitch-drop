(function () {
    try {
        const params = new URLSearchParams(window.location.search);
        const game = (params.get("game") || "").trim();
        if (game && game.toLowerCase() !== "none" && game.toLowerCase() !== "badges") {
            const headline = document.getElementById("headline");
            headline.innerHTML = "";
            headline.appendChild(document.createTextNode("Waiting for a live "));
            const span = document.createElement("span");
            span.className = "gameName";
            span.textContent = game;
            headline.appendChild(span);
            headline.appendChild(document.createTextNode(" stream…"));
            document.title = `Waiting for ${game} stream...`;
        } else if (game.toLowerCase() === "badges") {
            const headline = document.getElementById("headline");
            headline.textContent = "Waiting for a badge drop stream…";
        }
    } catch (e) {}
})();
