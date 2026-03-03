/**
 * Bug Condition Exploration Test - Chart Visual Quality Issues
 * 
 * This test is EXPECTED TO FAIL on unfixed code.
 * The failure confirms that the bug exists: Chart visual quality issues including
 * grid lines that are too prominent, axis labels that are too small, and insufficient
 * visual hierarchy between grid lines and data lines.
 * 
 * When this test FAILS, it proves the bug condition exists.
 * When this test PASSES (after fix), it confirms the expected behavior is satisfied.
 * 
 * **Validates: Requirements 1.1, 2.1**
 */

const fs = require('fs');
const path = require('path');

// Load the app.js file to extract the renderQueueTrend function
const appJsPath = path.join(__dirname, '../app.js');
const appJsContent = fs.readFileSync(appJsPath, 'utf8');

// Load the styles.css file to check CSS properties
const stylesPath = path.join(__dirname, '../styles.css');
const stylesContent = fs.readFileSync(stylesPath, 'utf8');

// Test utilities
function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function parseColor(colorStr) {
  // Convert hex color to RGB for comparison
  if (colorStr.startsWith('#')) {
    const hex = colorStr.slice(1);
    const r = parseInt(hex.slice(0, 2), 16);
    const g = parseInt(hex.slice(2, 4), 16);
    const b = parseInt(hex.slice(4, 6), 16);
    return { r, g, b };
  }
  return null;
}

function getColorBrightness(color) {
  // Calculate perceived brightness (0-255)
  // Using the formula: (0.299*R + 0.587*G + 0.114*B)
  return 0.299 * color.r + 0.587 * color.g + 0.114 * color.b;
}

function isLighterThan(color1Str, color2Str) {
  const color1 = parseColor(color1Str);
  const color2 = parseColor(color2Str);
  if (!color1 || !color2) return false;
  return getColorBrightness(color1) > getColorBrightness(color2);
}

// Extract CSS property values
function extractCssProperty(cssContent, selector, property) {
  // Simple regex-based CSS parser for testing
  const selectorRegex = new RegExp(`${selector.replace('.', '\\.')}\\s*{([^}]*)}`, 's');
  const match = cssContent.match(selectorRegex);
  if (!match) return null;
  
  const block = match[1];
  const propRegex = new RegExp(`${property}:\\s*([^;]+);`, 'i');
  const propMatch = block.match(propRegex);
  return propMatch ? propMatch[1].trim() : null;
}

// Extract grid line color from app.js source code
function extractGridLineColorFromSource(appJsSource) {
  // Look for the grid line rendering code in renderQueueTrend
  // Pattern: stroke="#E2E8F0" or similar
  const strokeMatch = appJsSource.match(/stroke=["']([#\w]+)["']\s+stroke-width=["']1["']/);
  return strokeMatch ? strokeMatch[1] : null;
}

// Run tests
function runTests() {
  let passCount = 0;
  let failCount = 0;
  const failures = [];

  console.log('\n=== Bug Condition Exploration Test - Chart Visual Quality ===\n');
  console.log('IMPORTANT: This test is EXPECTED TO FAIL on unfixed code.');
  console.log('Failure confirms the bug exists.\n');

  /**
   * Test Case 1: Grid line color should be lighter than #E2E8F0
   * 
   * EXPECTED TO FAIL on unfixed code:
   * - Current grid line color is #E2E8F0 (from app.js line 793-796)
   * - This color is too prominent and competes with data lines
   * - Expected: Grid lines should use a lighter color like #F1F5F9 or have reduced opacity
   */
  try {
    console.log('Test 1: Grid lines should use lighter color than #E2E8F0');
    
    // Extract the grid line color from app.js source
    const gridLineColor = extractGridLineColorFromSource(appJsContent);
    console.log(`  Actual grid line color: ${gridLineColor}`);
    
    assert(gridLineColor !== null, 'Grid line color should be found in app.js');
    
    const color = parseColor(gridLineColor);
    const brightness = getColorBrightness(color);
    console.log(`  Grid line brightness: ${brightness.toFixed(2)}/255`);
    
    // ASSERTION: Grid lines should be lighter than #E2E8F0
    // #E2E8F0 has brightness ~228, we expect something lighter like #F1F5F9 (~243)
    const e2e8f0Brightness = getColorBrightness(parseColor('#E2E8F0'));
    
    assert(
      isLighterThan(gridLineColor, '#E2E8F0'),
      `Grid line color ${gridLineColor} (brightness ${brightness.toFixed(2)}) should be lighter than #E2E8F0 (brightness ${e2e8f0Brightness.toFixed(2)}) for better visual hierarchy. Expected a lighter color like #F1F5F9 or reduced opacity.`
    );
    
    console.log('  ✓ PASSED (unexpected - bug may not exist or test is wrong)\n');
    passCount++;
  } catch (error) {
    console.log(`  ✗ FAILED (expected): ${error.message}`);
    console.log('  This confirms the bug: grid lines use #E2E8F0 which is too prominent\n');
    failCount++;
    failures.push({
      test: 'Test 1: Grid line color',
      actual: extractGridLineColorFromSource(appJsContent),
      expected: 'Lighter than #E2E8F0 (e.g., #F1F5F9)',
      error: error.message
    });
  }

  /**
   * Test Case 2: Axis label font size should be >= 10px for readability
   * 
   * EXPECTED TO FAIL on unfixed code:
   * - Current font size is 9px (from styles.css line 411-414)
   * - This is too small for comfortable reading on many screens
   * - Expected: Font size should be at least 10px
   */
  try {
    console.log('Test 2: Axis labels should have font size >= 10px');
    
    // Extract the axis-label font-size from CSS
    const fontSize = extractCssProperty(stylesContent, '.axis-label', 'font-size');
    console.log(`  Actual axis label font size: ${fontSize}`);
    
    assert(fontSize !== null, 'axis-label font-size should be defined in CSS');
    
    // Parse the font size value
    const fontSizeValue = parseFloat(fontSize);
    const fontSizeUnit = fontSize.replace(/[\d.]/g, '');
    
    // ASSERTION: Font size should be at least 10px
    assert(
      fontSizeUnit === 'px' && fontSizeValue >= 10,
      `Axis label font size should be >= 10px for readability. Current value is ${fontSize} which is too small. Expected at least 10px.`
    );
    
    console.log('  ✓ PASSED (unexpected - bug may not exist or test is wrong)\n');
    passCount++;
  } catch (error) {
    console.log(`  ✗ FAILED (expected): ${error.message}`);
    console.log('  This confirms the bug: axis labels use 9px font which is too small\n');
    failCount++;
    failures.push({
      test: 'Test 2: Axis label font size',
      actual: extractCssProperty(stylesContent, '.axis-label', 'font-size'),
      expected: '>= 10px',
      error: error.message
    });
  }

  /**
   * Test Case 3: Data lines should have higher visual weight than grid lines
   * 
   * EXPECTED TO FAIL on unfixed code:
   * - Grid lines use stroke-width: 1 and color #E2E8F0 (relatively prominent)
   * - Data lines use stroke-width: 2.4 (from styles.css line 419-447)
   * - The visual contrast may not be sufficient due to grid line prominence
   * - Expected: Grid lines should be more subtle (lighter color or reduced opacity)
   */
  try {
    console.log('Test 3: Data lines should have higher visual weight than grid lines');
    
    // Extract data line stroke-width from CSS
    const dataLineWidth = extractCssProperty(stylesContent, '.line-work', 'stroke-width');
    console.log(`  Data line stroke-width: ${dataLineWidth}`);
    
    // Extract grid line color
    const gridLineColor = extractGridLineColorFromSource(appJsContent);
    const gridColorBrightness = getColorBrightness(parseColor(gridLineColor));
    console.log(`  Grid line color: ${gridLineColor} (brightness ${gridColorBrightness.toFixed(2)}/255)`);
    
    // ASSERTION: Grid lines should be significantly lighter (higher brightness)
    // to ensure data lines have higher visual weight
    const minBrightnessForSubtleGrid = 240; // Out of 255
    assert(
      gridColorBrightness >= minBrightnessForSubtleGrid,
      `Grid lines should be more subtle to give data lines higher visual weight. Current grid color ${gridLineColor} has brightness ${gridColorBrightness.toFixed(2)}/255, which is too prominent. Expected brightness >= ${minBrightnessForSubtleGrid}/255 (e.g., #F1F5F9 has brightness ~243).`
    );
    
    console.log('  ✓ PASSED (unexpected - bug may not exist or test is wrong)\n');
    passCount++;
  } catch (error) {
    console.log(`  ✗ FAILED (expected): ${error.message}`);
    console.log('  This confirms the bug: grid lines are too prominent, competing with data lines\n');
    failCount++;
    failures.push({
      test: 'Test 3: Visual weight hierarchy',
      actual: `Grid brightness ${getColorBrightness(parseColor(extractGridLineColorFromSource(appJsContent))).toFixed(2)}/255`,
      expected: '>= 240/255',
      error: error.message
    });
  }

  /**
   * Test Case 4: Axis label color should have sufficient contrast
   * 
   * EXPECTED TO FAIL on unfixed code:
   * - Current color is #94a3b8 (from styles.css)
   * - This may not provide sufficient contrast for readability
   * - Expected: A darker color like #64748b for better contrast
   */
  try {
    console.log('Test 4: Axis labels should have sufficient color contrast');
    
    // Extract the axis-label color from CSS
    const labelColor = extractCssProperty(stylesContent, '.axis-label', 'fill');
    console.log(`  Actual axis label color: ${labelColor}`);
    
    assert(labelColor !== null, 'axis-label fill color should be defined in CSS');
    
    const color = parseColor(labelColor);
    const brightness = getColorBrightness(color);
    console.log(`  Axis label color brightness: ${brightness.toFixed(2)}/255`);
    
    // ASSERTION: Color should be dark enough for good contrast
    // Brightness should be below a certain threshold (darker colors have lower brightness)
    const maxBrightnessForGoodContrast = 140; // Out of 255
    assert(
      brightness <= maxBrightnessForGoodContrast,
      `Axis label color should be darker for better contrast. Current color ${labelColor} has brightness ${brightness.toFixed(2)}/255, which may be too light. Expected brightness <= ${maxBrightnessForGoodContrast}/255 (e.g., #64748b has brightness ~115).`
    );
    
    console.log('  ✓ PASSED (unexpected - bug may not exist or test is wrong)\n');
    passCount++;
  } catch (error) {
    console.log(`  ✗ FAILED (expected): ${error.message}`);
    console.log('  This confirms the bug: axis label color may lack sufficient contrast\n');
    failCount++;
    failures.push({
      test: 'Test 4: Axis label contrast',
      actual: extractCssProperty(stylesContent, '.axis-label', 'fill'),
      expected: 'Darker color (brightness <= 140/255)',
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
      console.log(`   Actual: ${failure.actual}`);
      console.log(`   Expected: ${failure.expected}`);
      console.log(`   Issue: ${failure.error}\n`);
    });
    
    console.log('✓ Bug condition confirmed: Chart has visual quality issues');
    console.log('  - Grid lines are too prominent (#E2E8F0)');
    console.log('  - Axis labels are too small (9px)');
    console.log('  - Insufficient visual hierarchy between grid and data lines\n');
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

