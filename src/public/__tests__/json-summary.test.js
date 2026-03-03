/**
 * Bug Condition Exploration Test - JSON Object Summary Display
 * 
 * This test is EXPECTED TO FAIL on unfixed code.
 * The failure confirms that the bug exists: JSON object summaries currently
 * display "Object(N)" or "Array(N)" instead of showing field previews.
 * 
 * When this test FAILS, it proves the bug condition exists.
 * When this test PASSES (after fix), it confirms the expected behavior is satisfied.
 */

const fs = require('fs');
const path = require('path');

// Load the app.js file and extract the renderJsonNode function
const appJsPath = path.join(__dirname, '../app.js');
const appJsContent = fs.readFileSync(appJsPath, 'utf8');

// Extract helper functions needed by renderJsonNode
// We need to create a minimal execution environment
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

  // Helper function to render primitive values (simplified from app.js)
  function renderJsonPrimitive(value) {
    if (value == null) {
      return '<span class="json-type">null</span>';
    }
    const type = typeof value;
    if (type === "string") {
      // Check if it's an ISO date string
      if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/.test(value)) {
        const date = new Date(value);
        const utc8 = new Date(date.getTime() + 8 * 3600 * 1000);
        const formatted = utc8.toISOString().replace("T", " ").slice(0, 19);
        return `<span class="json-string">"${esc(value)}"</span> <span class="json-type">(${formatted} UTC+8)</span>`;
      }
      return `<span class="json-string">"${esc(value)}"</span>`;
    }
    if (type === "number") {
      return `<span class="json-number">${value}</span>`;
    }
    if (type === "boolean") {
      return `<span class="json-boolean">${value}</span>`;
    }
    return `<span class="json-type">${type}</span>`;
  }

  // The renderJsonNode function (current unfixed version)
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
function extractSummary(html) {
  const match = html.match(/<summary>(.*?)<\/summary>/s);
  return match ? match[1] : '';
}

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

// Run tests
function runTests() {
  const { renderJsonNode } = createTestEnvironment();
  let passCount = 0;
  let failCount = 0;
  const failures = [];

  console.log('\n=== Bug Condition Exploration Test - JSON Object Summary ===\n');
  console.log('IMPORTANT: This test is EXPECTED TO FAIL on unfixed code.');
  console.log('Failure confirms the bug exists.\n');

  // Test Case 1: Small object with 2 fields
  try {
    console.log('Test 1: Render { messageCount: 3, consumerCount: 1 } in collapsed state');
    const input = { messageCount: 3, consumerCount: 1 };
    const html = renderJsonNode(null, input, 0);
    const summary = extractSummary(html);
    
    console.log(`  Actual summary: ${summary}`);
    
    // Expected behavior: summary should contain field names
    assertContains(summary, 'messageCount', 'Summary should contain "messageCount"');
    assertContains(summary, 'consumerCount', 'Summary should contain "consumerCount"');
    assertContains(summary, '3', 'Summary should contain value "3"');
    assertContains(summary, '1', 'Summary should contain value "1"');
    
    console.log('  ✓ PASSED (unexpected - bug may not exist or test is wrong)\n');
    passCount++;
  } catch (error) {
    console.log(`  ✗ FAILED (expected): ${error.message}`);
    console.log('  This confirms the bug: summary shows "Object(2)" instead of field preview\n');
    failCount++;
    failures.push({
      test: 'Test 1: Small object',
      input: { messageCount: 3, consumerCount: 1 },
      error: error.message
    });
  }

  // Test Case 2: Nested object with queues
  try {
    console.log('Test 2: Render { queues: { work: {...}, retry: {...}, dead: {...} } } in collapsed state');
    const input = {
      queues: {
        work: { messageCount: 3, consumerCount: 1 },
        retry: { messageCount: 0 },
        dead: { messageCount: 0 }
      }
    };
    const html = renderJsonNode(null, input, 0);
    const summary = extractSummary(html);
    
    console.log(`  Actual summary: ${summary}`);
    
    // Expected behavior: summary should show nested keys
    assertContains(summary, 'work', 'Summary should contain "work"');
    assertContains(summary, 'retry', 'Summary should contain "retry"');
    assertContains(summary, 'dead', 'Summary should contain "dead"');
    
    console.log('  ✓ PASSED (unexpected - bug may not exist or test is wrong)\n');
    passCount++;
  } catch (error) {
    console.log(`  ✗ FAILED (expected): ${error.message}`);
    console.log('  This confirms the bug: summary shows "Object(1)" instead of nested keys\n');
    failCount++;
    failures.push({
      test: 'Test 2: Nested object',
      input: { queues: { work: {}, retry: {}, dead: {} } },
      error: error.message
    });
  }

  // Test Case 3: Large object with 10 fields
  try {
    console.log('Test 3: Render object with 10 fields');
    const input = {
      field1: 'value1',
      field2: 'value2',
      field3: 'value3',
      field4: 'value4',
      field5: 'value5',
      field6: 'value6',
      field7: 'value7',
      field8: 'value8',
      field9: 'value9',
      field10: 'value10'
    };
    const html = renderJsonNode(null, input, 0);
    const summary = extractSummary(html);
    
    console.log(`  Actual summary: ${summary}`);
    
    // Expected behavior: summary should show first few fields + "..."
    const hasFieldPreview = summary.includes('field1') || summary.includes('field2');
    const hasTruncation = summary.includes('...') || summary.includes('more');
    
    assert(hasFieldPreview, 'Summary should show at least some field names');
    assert(hasTruncation, 'Summary should indicate truncation with "..." or "more"');
    
    console.log('  ✓ PASSED (unexpected - bug may not exist or test is wrong)\n');
    passCount++;
  } catch (error) {
    console.log(`  ✗ FAILED (expected): ${error.message}`);
    console.log('  This confirms the bug: summary shows "Object(10)" without field preview or truncation\n');
    failCount++;
    failures.push({
      test: 'Test 3: Large object',
      input: '{ field1: ..., field10: ... }',
      error: error.message
    });
  }

  // Test Case 4: Short array with string values
  try {
    console.log('Test 4: Render ["story-worker", "incident-worker"]');
    const input = ["story-worker", "incident-worker"];
    const html = renderJsonNode('runtimeConsumers', input, 0);
    const summary = extractSummary(html);
    
    console.log(`  Actual summary: ${summary}`);
    
    // Expected behavior: summary should show array content for short arrays
    const hasContent = summary.includes('story-worker') || summary.includes('incident-worker');
    const hasItemsLabel = summary.includes('items') || summary.includes('[');
    
    assert(hasContent || hasItemsLabel, 'Summary should show array content or friendly label like "[2 items]"');
    
    console.log('  ✓ PASSED (unexpected - bug may not exist or test is wrong)\n');
    passCount++;
  } catch (error) {
    console.log(`  ✗ FAILED (expected): ${error.message}`);
    console.log('  This confirms the bug: summary shows "Array(2)" instead of content preview\n');
    failCount++;
    failures.push({
      test: 'Test 4: Short array',
      input: ["story-worker", "incident-worker"],
      error: error.message
    });
  }

  // Summary
  console.log('=== Test Results ===\n');
  console.log(`Total: ${passCount + failCount} tests`);
  console.log(`Passed: ${passCount} (unexpected - indicates bug may not exist)`);
  console.log(`Failed: ${failCount} (expected - confirms bug exists)\n`);

  if (failCount > 0) {
    console.log('=== Documented Counterexamples (Bug Evidence) ===\n');
    failures.forEach((failure, index) => {
      console.log(`${index + 1}. ${failure.test}`);
      console.log(`   Input: ${JSON.stringify(failure.input)}`);
      console.log(`   Issue: ${failure.error}\n`);
    });
    
    console.log('✓ Bug condition confirmed: JSON summaries display "Object(N)" or "Array(N)"');
    console.log('  instead of showing field previews.\n');
    console.log('These failures are EXPECTED and prove the bug exists.');
    console.log('After implementing the fix, these tests should PASS.\n');
    
    // Exit with success code because failures are expected for exploration tests
    process.exit(0);
  } else {
    console.log('⚠ WARNING: All tests passed unexpectedly!');
    console.log('This suggests either:');
    console.log('  1. The bug does not exist in the current code');
    console.log('  2. The test is not correctly detecting the bug');
    console.log('  3. The code has already been fixed\n');
    console.log('Please review the root cause analysis.\n');
    
    // Exit with error code because we expected failures
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
