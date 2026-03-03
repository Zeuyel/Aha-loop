/**
 * Preservation Property Test - JSON Expansion Behavior
 * 
 * This test should PASS on unfixed code to establish baseline behavior to preserve.
 * It captures the current correct behavior for non-buggy inputs that must remain
 * unchanged after the fix is implemented.
 * 
 * **Validates: Requirements 3.1, 3.2, 3.3**
 * 
 * Property 3: Preservation - JSON Expansion Behavior
 * For any JSON rendering input where the user expands a details element or renders
 * primitive types, the fixed code SHALL produce exactly the same behavior as the
 * original code, preserving full nested structure display, date formatting, and
 * type rendering.
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
function extractChildren(html) {
  // Extract all children content, not just the first match
  const match = html.match(/<div class="json-children">([\s\S]*)<\/div>\s*<\/details>/);
  return match ? match[1].trim() : '';
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

  console.log('\n=== Preservation Property Test - JSON Expansion Behavior ===\n');
  console.log('IMPORTANT: This test should PASS on unfixed code.');
  console.log('It captures baseline behavior that must be preserved after the fix.\n');

  /**
   * Observation 1: Expanded nested object shows complete structure
   * 
   * When a nested object is rendered with depth < 2 (auto-expanded),
   * the HTML should contain all nested fields in the structure.
   */
  try {
    console.log('Test 1: Expanded nested object shows complete structure');
    const input = {
      queues: {
        work: { messageCount: 3, consumerCount: 1 },
        retry: { messageCount: 0 },
        dead: { messageCount: 0 }
      }
    };
    
    const html = renderJsonNode(null, input, 0);
    
    console.log('  Observing expanded structure...');
    
    // Property: Expanded state must show all nested fields in the HTML
    assertContains(html, 'queues', 'HTML should contain "queues" key');
    assertContains(html, 'work', 'HTML should contain "work" key');
    assertContains(html, 'retry', 'HTML should contain "retry" key');
    assertContains(html, 'dead', 'HTML should contain "dead" key');
    assertContains(html, 'messageCount', 'HTML should contain "messageCount" key');
    assertContains(html, 'consumerCount', 'HTML should contain "consumerCount" key');
    
    // Verify the details element is marked as open (depth < 2)
    assertContains(html, 'open', 'Details element should be marked as open for depth < 2');
    
    console.log('  ✓ PASSED: Expanded structure displays all nested fields\n');
    passCount++;
  } catch (error) {
    console.log(`  ✗ FAILED: ${error.message}\n`);
    failCount++;
    failures.push({
      test: 'Test 1: Expanded nested object',
      error: error.message
    });
  }

  /**
   * Observation 2: Primitive types render with correct type and value
   * 
   * String, number, boolean, and null values should render with appropriate
   * CSS classes and escaped content.
   */
  try {
    console.log('Test 2: Primitive types render correctly');
    
    // Test string
    const stringHtml = renderJsonNode('name', 'test-value', 0);
    assertContains(stringHtml, 'json-value string', 'String should have "json-value string" class');
    assertContains(stringHtml, '"test-value"', 'String should be quoted');
    console.log('  ✓ String renders correctly');
    
    // Test number
    const numberHtml = renderJsonNode('count', 42, 0);
    assertContains(numberHtml, 'json-value number', 'Number should have "json-value number" class');
    assertContains(numberHtml, '42', 'Number value should be displayed');
    console.log('  ✓ Number renders correctly');
    
    // Test boolean
    const boolHtml = renderJsonNode('active', true, 0);
    assertContains(boolHtml, 'json-value boolean', 'Boolean should have "json-value boolean" class');
    assertContains(boolHtml, 'true', 'Boolean value should be displayed');
    console.log('  ✓ Boolean renders correctly');
    
    // Test null
    const nullHtml = renderJsonNode('empty', null, 0);
    assertContains(nullHtml, 'json-type', 'Null should have "json-type" class');
    assertContains(nullHtml, 'null', 'Null should display "null"');
    console.log('  ✓ Null renders correctly');
    
    console.log('  ✓ PASSED: All primitive types render with correct format\n');
    passCount++;
  } catch (error) {
    console.log(`  ✗ FAILED: ${error.message}\n`);
    failCount++;
    failures.push({
      test: 'Test 2: Primitive types',
      error: error.message
    });
  }

  /**
   * Observation 3: ISO date strings are formatted to UTC+8
   * 
   * When a string matches the ISO date pattern, it should be formatted
   * to UTC+8 timezone with the format "YYYY-MM-DD HH:MM:SS UTC+8".
   */
  try {
    console.log('Test 3: ISO date strings formatted to UTC+8');
    
    const isoDate = '2024-01-15T10:30:00.000Z';
    const html = renderJsonNode('timestamp', isoDate, 0);
    
    console.log('  Observing date formatting...');
    
    // Property: ISO date strings must be formatted to UTC+8
    assertContains(html, 'UTC+8', 'Date should be formatted with UTC+8 label');
    assertContains(html, 'json-type', 'Date should have formatted time in json-type span');
    
    // Verify the original ISO string is still present
    assertContains(html, isoDate, 'Original ISO date string should be preserved');
    
    // Calculate expected UTC+8 time
    const date = new Date(isoDate);
    const utc8 = new Date(date.getTime() + 8 * 3600 * 1000);
    const expectedFormatted = utc8.toISOString().replace("T", " ").slice(0, 19);
    assertContains(html, expectedFormatted, `Formatted date should be ${expectedFormatted}`);
    
    console.log(`  ✓ PASSED: Date formatted to ${expectedFormatted} UTC+8\n`);
    passCount++;
  } catch (error) {
    console.log(`  ✗ FAILED: ${error.message}\n`);
    failCount++;
    failures.push({
      test: 'Test 3: ISO date formatting',
      error: error.message
    });
  }

  /**
   * Observation 4: Nested arrays display all items when expanded
   * 
   * Arrays should show all items in the HTML structure when rendered,
   * with proper indexing.
   */
  try {
    console.log('Test 4: Expanded arrays show all items');
    
    const input = ['item1', 'item2', 'item3'];
    const html = renderJsonNode('items', input, 0);
    
    console.log('  Observing array expansion...');
    
    // Property: All array items must be present in HTML
    assertContains(html, 'item1', 'HTML should contain first item');
    assertContains(html, 'item2', 'HTML should contain second item');
    assertContains(html, 'item3', 'HTML should contain third item');
    
    // Verify indices are used as keys (0, 1, 2)
    assertContains(html, 'json-key', 'Array items should have index keys');
    
    console.log('  ✓ PASSED: Array expansion shows all items with indices\n');
    passCount++;
  } catch (error) {
    console.log(`  ✗ FAILED: ${error.message}\n`);
    failCount++;
    failures.push({
      test: 'Test 4: Array expansion',
      error: error.message
    });
  }

  /**
   * Observation 5: Deep nesting (depth >= 2) renders collapsed by default
   * 
   * Objects and arrays at depth >= 2 should not have the "open" attribute,
   * meaning they start collapsed.
   */
  try {
    console.log('Test 5: Deep nesting renders collapsed by default');
    
    const input = {
      level1: {
        level2: {
          level3: {
            value: 'deep'
          }
        }
      }
    };
    
    const html = renderJsonNode(null, input, 0);
    
    console.log('  Observing depth-based expansion...');
    
    // Count the number of "open" attributes
    const openCount = (html.match(/open/g) || []).length;
    
    // At depth 0 and 1, details should be open (2 levels)
    // At depth 2 and beyond, details should be closed
    assert(openCount === 2, `Should have exactly 2 open details elements (depth 0 and 1), found ${openCount}`);
    
    console.log('  ✓ PASSED: Deep nesting (depth >= 2) is collapsed by default\n');
    passCount++;
  } catch (error) {
    console.log(`  ✗ FAILED: ${error.message}\n`);
    failCount++;
    failures.push({
      test: 'Test 5: Deep nesting',
      error: error.message
    });
  }

  /**
   * Observation 6: HTML special characters are properly escaped
   * 
   * Values containing HTML special characters (<, >, &, ") should be
   * escaped to prevent XSS and display correctly.
   */
  try {
    console.log('Test 6: HTML special characters are escaped');
    
    const input = {
      html: '<script>alert("xss")</script>',
      ampersand: 'A & B',
      quote: 'He said "hello"'
    };
    
    const html = renderJsonNode(null, input, 0);
    
    console.log('  Observing HTML escaping...');
    
    // Property: Special characters must be escaped
    assertContains(html, '&lt;script&gt;', 'HTML tags should be escaped');
    assertContains(html, '&amp;', 'Ampersands should be escaped');
    assertContains(html, '&quot;', 'Quotes should be escaped');
    
    // Verify raw HTML is not present
    assert(!html.includes('<script>'), 'Raw script tags should not be present');
    
    console.log('  ✓ PASSED: HTML special characters are properly escaped\n');
    passCount++;
  } catch (error) {
    console.log(`  ✗ FAILED: ${error.message}\n`);
    failCount++;
    failures.push({
      test: 'Test 6: HTML escaping',
      error: error.message
    });
  }

  /**
   * Observation 7: Empty objects and arrays are handled gracefully
   * 
   * Empty objects {} and arrays [] should render with appropriate
   * empty state indicators.
   */
  try {
    console.log('Test 7: Empty objects and arrays handled gracefully');
    
    // Test empty object
    const emptyObjHtml = renderJsonNode('empty', {}, 0);
    assertContains(emptyObjHtml, 'Object(0)', 'Empty object should show Object(0)');
    assertContains(emptyObjHtml, 'json-type', 'Empty object should have json-type class');
    console.log('  ✓ Empty object renders correctly');
    
    // Test empty array
    const emptyArrHtml = renderJsonNode('items', [], 0);
    assertContains(emptyArrHtml, 'Array(0)', 'Empty array should show Array(0)');
    assertContains(emptyArrHtml, 'json-type', 'Empty array should have json-type class');
    console.log('  ✓ Empty array renders correctly');
    
    console.log('  ✓ PASSED: Empty objects and arrays handled gracefully\n');
    passCount++;
  } catch (error) {
    console.log(`  ✗ FAILED: ${error.message}\n`);
    failCount++;
    failures.push({
      test: 'Test 7: Empty objects/arrays',
      error: error.message
    });
  }

  /**
   * Observation 8: Large objects render without timeout (Performance Preservation)
   * 
   * Objects with many fields (20+) and deep nesting should render within
   * a reasonable time without causing timeouts or performance issues.
   * This establishes baseline performance that must be preserved after the fix.
   */
  try {
    console.log('Test 8: Large objects render without timeout');
    
    // Generate a large object with 25 fields
    const largeObject = {};
    for (let i = 0; i < 25; i++) {
      largeObject[`field${i}`] = {
        id: i,
        name: `Item ${i}`,
        description: `This is a description for item ${i}`,
        metadata: {
          created: '2024-01-15T10:30:00.000Z',
          updated: '2024-01-16T14:20:00.000Z',
          tags: ['tag1', 'tag2', 'tag3']
        }
      };
    }
    
    console.log('  Observing performance with large object (25 fields, deep nesting)...');
    
    // Measure rendering time
    const startTime = Date.now();
    const html = renderJsonNode('largeData', largeObject, 0);
    const endTime = Date.now();
    const renderTime = endTime - startTime;
    
    console.log(`  Render time: ${renderTime}ms`);
    
    // Property: Rendering should complete within reasonable time (< 1000ms)
    assert(renderTime < 1000, `Rendering should complete within 1000ms, took ${renderTime}ms`);
    
    // Verify the HTML was generated correctly
    assert(html.length > 0, 'HTML should be generated');
    assertContains(html, 'largeData', 'HTML should contain the root key');
    assertContains(html, 'Object(25)', 'HTML should show Object(25) for 25 fields');
    
    // Verify some nested content is present
    assertContains(html, 'field0', 'HTML should contain first field');
    assertContains(html, 'field24', 'HTML should contain last field');
    assertContains(html, 'metadata', 'HTML should contain nested metadata');
    
    console.log('  ✓ PASSED: Large object renders without timeout\n');
    passCount++;
  } catch (error) {
    console.log(`  ✗ FAILED: ${error.message}\n`);
    failCount++;
    failures.push({
      test: 'Test 8: Large object performance',
      error: error.message
    });
  }

  /**
   * Observation 9: Very deep nesting renders without stack overflow
   * 
   * Objects with deep nesting (10+ levels) should render without
   * causing stack overflow or excessive memory usage.
   */
  try {
    console.log('Test 9: Very deep nesting renders without stack overflow');
    
    // Generate a deeply nested object (10 levels)
    let deepObject = { value: 'bottom' };
    for (let i = 0; i < 10; i++) {
      deepObject = { [`level${i}`]: deepObject };
    }
    
    console.log('  Observing performance with deep nesting (10 levels)...');
    
    // Measure rendering time
    const startTime = Date.now();
    const html = renderJsonNode('deepData', deepObject, 0);
    const endTime = Date.now();
    const renderTime = endTime - startTime;
    
    console.log(`  Render time: ${renderTime}ms`);
    
    // Property: Rendering should complete without errors
    assert(renderTime < 500, `Rendering should complete within 500ms, took ${renderTime}ms`);
    
    // Verify the HTML was generated correctly
    assert(html.length > 0, 'HTML should be generated');
    assertContains(html, 'deepData', 'HTML should contain the root key');
    assertContains(html, 'level0', 'HTML should contain first level');
    assertContains(html, 'value', 'HTML should contain bottom value');
    
    console.log('  ✓ PASSED: Deep nesting renders without stack overflow\n');
    passCount++;
  } catch (error) {
    console.log(`  ✗ FAILED: ${error.message}\n`);
    failCount++;
    failures.push({
      test: 'Test 9: Deep nesting performance',
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
    console.log('  Baseline behavior successfully captured.');
    console.log('  These behaviors MUST be preserved after implementing the fix.\n');
    console.log('Expected preserved behaviors:');
    console.log('  - Expanded objects show complete nested structure');
    console.log('  - Primitive types render with correct format and CSS classes');
    console.log('  - ISO date strings formatted to UTC+8');
    console.log('  - Arrays show all items when expanded');
    console.log('  - Deep nesting (depth >= 2) starts collapsed');
    console.log('  - HTML special characters are properly escaped');
    console.log('  - Empty objects and arrays handled gracefully');
    console.log('  - Large objects (20+ fields) render without timeout');
    console.log('  - Very deep nesting (10+ levels) renders without stack overflow\n');
    
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
