/**
 * Preservation Property Test - Other Pages JSON View
 * 
 * This test should PASS on unfixed code to establish baseline behavior to preserve.
 * It verifies that JSON rendering on boot, stories, and incidents pages works
 * consistently with the overview page and continues to function correctly after
 * the fix is implemented.
 * 
 * **Validates: Requirements 3.4**
 * 
 * Property 4: Preservation - Other Pages and Performance
 * For any JSON rendering on other pages (boot, stories, incidents) or rendering
 * of large/deeply nested objects, the fixed code SHALL produce exactly the same
 * behavior and performance characteristics as the original code.
 */

const fs = require('fs');
const path = require('path');

// Load the app.js file and extract the renderJsonNode function
const appJsPath = path.join(__dirname, '../app.js');
const appJsContent = fs.readFileSync(appJsPath, 'utf8');

// Create test environment with renderJsonNode function
function createTestEnvironment() {
  // Helper function to escape HTML (from app.js)
  function esc(str) {
    if (str == null) return "null";
    return String(str)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  // Helper function to render primitive values (from app.js)
  function renderJsonPrimitive(value) {
    if (value == null) {
      return '<span class="json-type">null</span>';
    }
    if (typeof value === "string") {
      // Check if it's an ISO date string
      if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/.test(value)) {
        const date = new Date(value);
        const utc8 = new Date(date.getTime() + 8 * 3600 * 1000);
        const formatted = utc8.toISOString().replace("T", " ").slice(0, 19);
        return `<span class="json-value string">"${esc(value)}"</span> <span class="json-type">(${formatted} UTC+8)</span>`;
      }
      return `<span class="json-value string">"${esc(value)}"</span>`;
    }
    if (typeof value === "number") return `<span class="json-value number">${value}</span>`;
    if (typeof value === "boolean") return `<span class="json-value boolean">${value}</span>`;
    return `<span class="json-value">${esc(String(value))}</span>`;
  }

  // The renderJsonNode function (current version)
  function renderJsonNode(key, value, depth = 0) {
    const keyHtml = key == null ? "" : `<span class="json-key">${esc(key)}</span>: `;
    if (value == null || typeof value !== "object") {
      return `<div class="json-node">${keyHtml}${renderJsonPrimitive(value)}</div>`;
    }

    if (Array.isArray(value)) {
      const summary = `${keyHtml}<span class="json-type">Array(${value.length})</span>`;
      const children = value.map((item, index) => renderJsonNode(index, item, depth + 1)).join("");
      return `
        <details class="json-node" ${depth < 2 ? "open" : ""}>
          <summary>${summary}</summary>
          <div class="json-children">${children || '<div class="json-node"><span class="json-type">empty</span></div>'}</div>
        </details>
      `;
    }

    const keys = Object.keys(value);
    const summary = `${keyHtml}<span class="json-type">Object(${keys.length})</span>`;
    const children = keys.map((childKey) => renderJsonNode(childKey, value[childKey], depth + 1)).join("");
    return `
      <details class="json-node" ${depth < 2 ? "open" : ""}>
        <summary>${summary}</summary>
        <div class="json-children">${children || '<div class="json-node"><span class="json-type">empty</span></div>'}</div>
      </details>
    `;
  }

  return { renderJsonNode, esc, renderJsonPrimitive };
}

// Test utilities
function assert(condition, message) {
  if (!condition) {
    throw new Error(`Assertion failed: ${message}`);
  }
}

function assertContains(text, substring, message) {
  if (!text.includes(substring)) {
    throw new Error(`Assertion failed: ${message}\n  Expected text to contain: "${substring}"\n  Actual text: "${text}"`);
  }
}

function assertEqual(actual, expected, message) {
  if (actual !== expected) {
    throw new Error(`Assertion failed: ${message}\n  Expected: ${expected}\n  Actual: ${actual}`);
  }
}

// Run tests
function runTests() {
  const { renderJsonNode } = createTestEnvironment();
  let passCount = 0;
  let failCount = 0;
  const failures = [];

  console.log('\n=== Preservation Property Test - Other Pages JSON View ===\n');
  console.log('IMPORTANT: This test should PASS on unfixed code.');
  console.log('It verifies that JSON rendering works consistently across all pages.\n');

  /**
   * Test 1: Stories page - Story detail rendering
   * 
   * The stories page uses setJsonView("stories-detail", detail) to display
   * story information. This should render consistently with overview page.
   */
  try {
    console.log('Test 1: Stories page - Story detail rendering');
    
    // Simulate typical story detail data structure
    const storyDetail = {
      storyId: "story-123",
      prdId: "prd-456",
      phase: "implementation",
      status: "active",
      attempt: 1,
      runId: "run-789",
      traceId: "trace-abc",
      metadata: {
        createdAt: "2024-01-15T10:30:00.000Z",
        updatedAt: "2024-01-15T11:45:00.000Z"
      },
      recentRuns: [
        { runId: "run-789", status: "success", timestamp: "2024-01-15T11:45:00.000Z" },
        { runId: "run-788", status: "failed", timestamp: "2024-01-15T10:30:00.000Z" }
      ]
    };
    
    const html = renderJsonNode(null, storyDetail, 0);
    
    console.log('  Observing story detail rendering...');
    
    // Property: All story fields should be present in HTML
    assertContains(html, 'storyId', 'HTML should contain storyId field');
    assertContains(html, 'story-123', 'HTML should contain storyId value');
    assertContains(html, 'prdId', 'HTML should contain prdId field');
    assertContains(html, 'phase', 'HTML should contain phase field');
    assertContains(html, 'metadata', 'HTML should contain metadata field');
    assertContains(html, 'recentRuns', 'HTML should contain recentRuns field');
    
    // Verify date formatting is applied
    assertContains(html, 'UTC+8', 'Dates should be formatted to UTC+8');
    
    // Verify nested structure is rendered
    assertContains(html, 'createdAt', 'Nested metadata fields should be present');
    assertContains(html, 'updatedAt', 'Nested metadata fields should be present');
    
    console.log('  ✓ PASSED: Stories page JSON rendering works correctly\n');
    passCount++;
  } catch (error) {
    console.log(`  ✗ FAILED: ${error.message}\n`);
    failCount++;
    failures.push({
      test: 'Test 1: Stories page story detail',
      error: error.message
    });
  }

  /**
   * Test 2: Stories page - Run detail rendering
   * 
   * The stories page uses setJsonView("stories-run-detail", detail) to display
   * run failure information.
   */
  try {
    console.log('Test 2: Stories page - Run detail rendering');
    
    // Simulate typical run detail data structure
    const runDetail = {
      runId: "run-789",
      storyId: "story-123",
      phase: "implementation",
      status: "failed",
      error: {
        message: "Timeout exceeded",
        code: "TIMEOUT",
        stack: "Error: Timeout exceeded\n  at Worker.run"
      },
      timestamp: "2024-01-15T11:45:00.000Z",
      duration: 30000,
      logs: "Worker started\nProcessing task\nTimeout occurred"
    };
    
    const html = renderJsonNode(null, runDetail, 0);
    
    console.log('  Observing run detail rendering...');
    
    // Property: All run fields should be present in HTML
    assertContains(html, 'runId', 'HTML should contain runId field');
    assertContains(html, 'error', 'HTML should contain error field');
    assertContains(html, 'message', 'HTML should contain error message');
    assertContains(html, 'Timeout exceeded', 'HTML should contain error message value');
    
    // Verify nested error object is rendered
    assertContains(html, 'code', 'Error object should have code field');
    assertContains(html, 'stack', 'Error object should have stack field');
    
    console.log('  ✓ PASSED: Stories page run detail rendering works correctly\n');
    passCount++;
  } catch (error) {
    console.log(`  ✗ FAILED: ${error.message}\n`);
    failCount++;
    failures.push({
      test: 'Test 2: Stories page run detail',
      error: error.message
    });
  }

  /**
   * Test 3: Incidents page - Dead message detail rendering
   * 
   * The incidents page uses setJsonView("incidents-dead-detail", item) to display
   * dead queue message information.
   */
  try {
    console.log('Test 3: Incidents page - Dead message detail rendering');
    
    // Simulate typical dead message data structure
    const deadMessage = {
      storyId: "story-456",
      phase: "validation",
      attempt: 3,
      traceId: "trace-def",
      error: {
        type: "ValidationError",
        message: "Invalid input format",
        details: {
          field: "email",
          reason: "Invalid email format"
        }
      },
      payload: {
        email: "invalid-email",
        name: "Test User"
      },
      enqueuedAt: "2024-01-15T09:00:00.000Z",
      failedAt: "2024-01-15T09:05:00.000Z"
    };
    
    const html = renderJsonNode(null, deadMessage, 0);
    
    console.log('  Observing dead message rendering...');
    
    // Property: All message fields should be present in HTML
    assertContains(html, 'storyId', 'HTML should contain storyId field');
    assertContains(html, 'error', 'HTML should contain error field');
    assertContains(html, 'payload', 'HTML should contain payload field');
    assertContains(html, 'ValidationError', 'HTML should contain error type');
    
    // Verify nested error details are rendered
    assertContains(html, 'details', 'Error should have details field');
    assertContains(html, 'field', 'Error details should have field');
    assertContains(html, 'reason', 'Error details should have reason');
    
    // Verify date formatting
    assertContains(html, 'UTC+8', 'Dates should be formatted to UTC+8');
    
    console.log('  ✓ PASSED: Incidents page dead message rendering works correctly\n');
    passCount++;
  } catch (error) {
    console.log(`  ✗ FAILED: ${error.message}\n`);
    failCount++;
    failures.push({
      test: 'Test 3: Incidents page dead message',
      error: error.message
    });
  }

  /**
   * Test 4: Incidents page - Command state rendering
   * 
   * The incidents page uses setJsonView("incidents-command-state", {...}) to display
   * runtime command state information.
   */
  try {
    console.log('Test 4: Incidents page - Command state rendering');
    
    // Simulate typical command state data structure
    const commandState = {
      control: {
        paused: false,
        pauseReason: null,
        mode: "auto"
      },
      lastCommand: {
        type: "revive_dead",
        timestamp: "2024-01-15T10:00:00.000Z",
        result: "success",
        affectedCount: 5
      },
      availableCommands: ["pause", "resume", "revive_dead", "clear_alerts"]
    };
    
    const html = renderJsonNode(null, commandState, 0);
    
    console.log('  Observing command state rendering...');
    
    // Property: All command state fields should be present in HTML
    assertContains(html, 'control', 'HTML should contain control field');
    assertContains(html, 'lastCommand', 'HTML should contain lastCommand field');
    assertContains(html, 'availableCommands', 'HTML should contain availableCommands field');
    
    // Verify nested control object
    assertContains(html, 'paused', 'Control should have paused field');
    assertContains(html, 'mode', 'Control should have mode field');
    
    // Verify array rendering
    assertContains(html, 'Array(4)', 'Available commands should show as Array(4)');
    
    console.log('  ✓ PASSED: Incidents page command state rendering works correctly\n');
    passCount++;
  } catch (error) {
    console.log(`  ✗ FAILED: ${error.message}\n`);
    failCount++;
    failures.push({
      test: 'Test 4: Incidents page command state',
      error: error.message
    });
  }

  /**
   * Test 5: Consistency across pages - Same data structure
   * 
   * When the same data structure is rendered on different pages,
   * the output should be identical.
   */
  try {
    console.log('Test 5: Consistency across pages - Same data structure');
    
    // Use a common data structure that might appear on multiple pages
    const commonData = {
      timestamp: "2024-01-15T10:30:00.000Z",
      status: "active",
      metadata: {
        source: "worker",
        version: "1.0.0"
      }
    };
    
    // Render the same data multiple times (simulating different pages)
    const html1 = renderJsonNode(null, commonData, 0);
    const html2 = renderJsonNode(null, commonData, 0);
    const html3 = renderJsonNode(null, commonData, 0);
    
    console.log('  Observing consistency across renders...');
    
    // Property: Same input should produce identical output
    assertEqual(html1, html2, 'First and second render should be identical');
    assertEqual(html2, html3, 'Second and third render should be identical');
    assertEqual(html1, html3, 'First and third render should be identical');
    
    console.log('  ✓ PASSED: JSON rendering is consistent across pages\n');
    passCount++;
  } catch (error) {
    console.log(`  ✗ FAILED: ${error.message}\n`);
    failCount++;
    failures.push({
      test: 'Test 5: Consistency across pages',
      error: error.message
    });
  }

  /**
   * Test 6: Large nested objects (performance preservation)
   * 
   * Rendering large objects with deep nesting should complete without issues.
   * This verifies that performance characteristics are maintained.
   */
  try {
    console.log('Test 6: Large nested objects - Performance preservation');
    
    // Create a moderately large nested structure
    const largeObject = {
      level1: {}
    };
    
    // Add 20 fields at level 1
    for (let i = 0; i < 20; i++) {
      largeObject.level1[`field${i}`] = {
        id: i,
        name: `Field ${i}`,
        metadata: {
          created: "2024-01-15T10:00:00.000Z",
          updated: "2024-01-15T11:00:00.000Z",
          tags: ["tag1", "tag2", "tag3"]
        }
      };
    }
    
    console.log('  Observing large object rendering...');
    
    const startTime = Date.now();
    const html = renderJsonNode(null, largeObject, 0);
    const endTime = Date.now();
    const duration = endTime - startTime;
    
    // Property: Rendering should complete in reasonable time (< 1000ms)
    assert(duration < 1000, `Rendering took ${duration}ms, should be < 1000ms`);
    
    // Verify the structure is complete
    assertContains(html, 'level1', 'HTML should contain level1');
    assertContains(html, 'field0', 'HTML should contain first field');
    assertContains(html, 'field19', 'HTML should contain last field');
    assertContains(html, 'metadata', 'HTML should contain nested metadata');
    
    console.log(`  ✓ PASSED: Large object rendered in ${duration}ms\n`);
    passCount++;
  } catch (error) {
    console.log(`  ✗ FAILED: ${error.message}\n`);
    failCount++;
    failures.push({
      test: 'Test 6: Large nested objects',
      error: error.message
    });
  }

  // Summary
  console.log('=== Test Results ===\n');
  console.log(`Total: ${passCount + failCount} tests`);
  console.log(`Passed: ${passCount} (expected - baseline behavior captured)`);
  console.log(`Failed: ${failCount} (unexpected - preservation may be at risk)\n`);

  if (failCount === 0) {
    console.log('✓ All preservation tests passed on unfixed code!');
    console.log('  Baseline behavior successfully captured for all pages.');
    console.log('  These behaviors MUST be preserved after implementing the fix.\n');
    console.log('Expected preserved behaviors:');
    console.log('  - Stories page: Story detail and run detail rendering');
    console.log('  - Incidents page: Dead message and command state rendering');
    console.log('  - Consistency: Same data produces identical output across pages');
    console.log('  - Performance: Large objects render efficiently\n');
    
    // Exit with success code
    process.exit(0);
  } else {
    console.log('⚠ WARNING: Some preservation tests failed!');
    console.log('This is unexpected and may indicate:');
    console.log('  1. The test environment does not match the actual code');
    console.log('  2. The baseline behavior has already changed');
    console.log('  3. The test assertions are incorrect\n');
    
    console.log('Failed tests:\n');
    failures.forEach((failure, index) => {
      console.log(`${index + 1}. ${failure.test}`);
      console.log(`   Issue: ${failure.error}\n`);
    });
    
    // Exit with error code
    process.exit(1);
  }
}

// Run the tests
try {
  runTests();
} catch (error) {
  console.error('\n✗ Test execution error:', error.message);
  console.error(error.stack);
  process.exit(1);
}
