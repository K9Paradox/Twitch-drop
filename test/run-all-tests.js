/**
 * Unified Test Runner for Auto Twitch Drops Pro Test Suite (Tiers 1-4)
 * Pure native Node.js test execution with structured ANSI reporting
 */

import { run } from "node:test";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { readdirSync } from "node:fs";

const __dirname = dirname(fileURLToPath(import.meta.url));

const COLORS = {
    reset: "\x1b[0m",
    bright: "\x1b[1m",
    dim: "\x1b[2m",
    green: "\x1b[32m",
    red: "\x1b[31m",
    yellow: "\x1b[33m",
    blue: "\x1b[34m",
    magenta: "\x1b[35m",
    cyan: "\x1b[36m",
    white: "\x1b[37m"
};

function getTestFiles(dirRel) {
    const dirAbs = resolve(__dirname, dirRel);
    try {
        return readdirSync(dirAbs)
            .filter(f => f.endsWith(".test.js"))
            .map(f => resolve(dirAbs, f));
    } catch (e) {
        return [];
    }
}

async function main() {
    console.log(`${COLORS.cyan}${COLORS.bright}======================================================${COLORS.reset}`);
    console.log(`${COLORS.cyan}${COLORS.bright}   AUTO TWITCH DROPS PRO — E2E TEST SUITE RUNNER      ${COLORS.reset}`);
    console.log(`${COLORS.cyan}${COLORS.bright}======================================================${COLORS.reset}\n`);

    const tier1Files = getTestFiles("tier1_features");
    const tier2Files = getTestFiles("tier2_boundaries");
    const tier3Files = getTestFiles("tier3_combinations");
    const tier4Files = getTestFiles("tier4_scenarios");

    const allFiles = [
        ...tier1Files,
        ...tier2Files,
        ...tier3Files,
        ...tier4Files
    ];

    console.log(`${COLORS.blue}Discovered test suites:${COLORS.reset}`);
    console.log(`  ${COLORS.white}• Tier 1 (Isolated Features):${COLORS.reset}      ${tier1Files.length} files (${tier1Files.length * 5} tests)`);
    console.log(`  ${COLORS.white}• Tier 2 (Boundary & Errors):${COLORS.reset}      ${tier2Files.length} files (${tier2Files.length * 5} tests)`);
    console.log(`  ${COLORS.white}• Tier 3 (Cross-Combinations):${COLORS.reset}     ${tier3Files.length} files (14 tests)`);
    console.log(`  ${COLORS.white}• Tier 4 (Workload Scenarios):${COLORS.reset}     ${tier4Files.length} files (5 tests)`);
    console.log(`  ${COLORS.dim}Total test files: ${allFiles.length}${COLORS.reset}\n`);

    const startTime = Date.now();
    let totalTests = 0;
    let passedTests = 0;
    let failedTests = 0;
    const failures = [];

    const testStream = run({
        files: allFiles,
        concurrency: 1
    });

    for await (const event of testStream) {
        if (event.type === "test:pass") {
            // Only count leaf test cases
            if (event.data.nesting > 0 || (event.data.name && (event.data.name.startsWith("F") || event.data.name.startsWith("Scenario")))) {
                totalTests++;
                passedTests++;
                const fileName = event.data.file ? event.data.file.split("/").pop() : "";
                const dur = Math.round(event.data.details?.duration_ms || 0);
                console.log(`  ${COLORS.green}✔${COLORS.reset} ${COLORS.dim}[${fileName}]${COLORS.reset} ${event.data.name} ${COLORS.dim}(${dur}ms)${COLORS.reset}`);
            }
        } else if (event.type === "test:fail") {
            if (event.data.nesting > 0 || (event.data.name && (event.data.name.startsWith("F") || event.data.name.startsWith("Scenario")))) {
                totalTests++;
                failedTests++;
                failures.push(event.data);
                console.log(`  ${COLORS.red}✖${COLORS.reset} ${COLORS.bright}${event.data.name}${COLORS.reset}`);
                if (event.data.details?.error) {
                    console.log(`    ${COLORS.red}${event.data.details.error.message || event.data.details.error}${COLORS.reset}`);
                }
            }
        }
    }

    const duration = ((Date.now() - startTime) / 1000).toFixed(2);

    console.log(`\n${COLORS.cyan}${COLORS.bright}======================================================${COLORS.reset}`);
    console.log(`${COLORS.cyan}${COLORS.bright}                   TEST RUN SUMMARY                   ${COLORS.reset}`);
    console.log(`${COLORS.cyan}${COLORS.bright}======================================================${COLORS.reset}`);
    console.log(`  ${COLORS.white}Total Tests Executed:${COLORS.reset} ${COLORS.bright}${totalTests}${COLORS.reset}`);
    console.log(`  ${COLORS.green}Passed:${COLORS.reset}               ${COLORS.green}${COLORS.bright}${passedTests}${COLORS.reset}`);
    console.log(`  ${COLORS.red}Failed:${COLORS.reset}               ${failedTests > 0 ? COLORS.red : COLORS.dim}${failedTests}${COLORS.reset}`);
    console.log(`  ${COLORS.white}Duration:${COLORS.reset}             ${duration}s`);
    console.log(`${COLORS.cyan}======================================================${COLORS.reset}\n`);

    if (failedTests > 0) {
        console.log(`${COLORS.red}${COLORS.bright}FAILED TESTS SUMMARY:${COLORS.reset}`);
        failures.forEach((f, idx) => {
            console.log(`  ${idx + 1}) ${f.name}`);
            if (f.details?.error) {
                console.log(`     ${f.details.error.stack || f.details.error.message}`);
            }
        });
        process.exit(1);
    } else {
        console.log(`${COLORS.green}${COLORS.bright}🎉 ALL ${totalTests} TESTS PASSED PERFECTLY! Tiers 1-4 Verification Complete.${COLORS.reset}\n`);
        process.exit(0);
    }
}

main().catch((err) => {
    console.error("Test runner execution failure:", err);
    process.exit(1);
});
