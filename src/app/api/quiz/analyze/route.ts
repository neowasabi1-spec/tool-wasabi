import { NextRequest, NextResponse } from 'next/server';

export async function POST(request: NextRequest) {
  try {
    const { url, name } = await request.json();

    if (!url) {
      return NextResponse.json(
        { success: false, error: 'URL is required' },
        { status: 400 }
      );
    }

    // Fetch the quiz page to extract content
    const pageResponse = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; QuizAnalyzer/1.0)',
      },
    });

    if (!pageResponse.ok) {
      return NextResponse.json(
        { success: false, error: `Unable to load the page: ${pageResponse.status}` },
        { status: 400 }
      );
    }

    const html = await pageResponse.text();
    const contentLength = html.length;

    // Extract quiz-specific elements from the page
    const extractedElements = {
      forms: (html.match(/<form[^>]*>[\s\S]*?<\/form>/gi) || []).length,
      radioInputs: (html.match(/<input[^>]*type="radio"[^>]*>/gi) || []).length,
      checkboxInputs: (html.match(/<input[^>]*type="checkbox"[^>]*>/gi) || []).length,
      buttons: (html.match(/<button[^>]*>[\s\S]*?<\/button>/gi) || []).length,
      progressBars: (html.match(/progress|step|indicator/gi) || []).length,
      questions: (html.match(/<h[1-6][^>]*>.*\?<\/h[1-6]>/gi) || []).length,
      images: (html.match(/<img[^>]*>/gi) || []).length,
    };

    // Extract question texts
    const questionTexts: string[] = [];
    const questionMatches = html.match(/<h[1-6][^>]*>([^<]*\?)[^<]*<\/h[1-6]>/gi) || [];
    questionMatches.forEach((match) => {
      const text = match.replace(/<[^>]*>/g, '').trim();
      if (text.length > 5 && text.length < 300) {
        questionTexts.push(text);
      }
    });

    // Extract answer options
    const optionTexts: string[] = [];
    const labelMatches = html.match(/<label[^>]*>([\s\S]*?)<\/label>/gi) || [];
    labelMatches.forEach((match) => {
      const text = match.replace(/<[^>]*>/g, '').trim();
      if (text.length > 2 && text.length < 200) {
        optionTexts.push(text);
      }
    });

    // Extract final CTAs
    const ctaElements: string[] = [];
    const ctaMatches = html.match(/<(button|a)[^>]*class="[^"]*(?:btn|cta|submit|next)[^"]*"[^>]*>([\s\S]*?)<\/(button|a)>/gi) || [];
    ctaMatches.forEach((match) => {
      const text = match.replace(/<[^>]*>/g, '').trim();
      if (text && text.length < 100) {
        ctaElements.push(text);
      }
    });

    // Build the prompt for AI quiz analysis
    const prompt = `You are a Quiz Funnel Marketing expert. Analyze this quiz funnel in detail:

TEMPLATE NAME: ${name || 'Quiz Template'}
URL: ${url}

EXTRACTED ELEMENTS:
- Forms detected: ${extractedElements.forms}
- Radio inputs (single choice): ${extractedElements.radioInputs}
- Checkbox inputs (multiple choice): ${extractedElements.checkboxInputs}
- Buttons: ${extractedElements.buttons}
- Progress/step elements: ${extractedElements.progressBars}
- Questions with "?" detected: ${extractedElements.questions}
- Images: ${extractedElements.images}
- HTML content length: ${contentLength} characters

EXTRACTED QUESTIONS:
${questionTexts.slice(0, 10).map((q, i) => `${i + 1}. ${q}`).join('\n') || 'No questions found with "?"'}

ANSWER OPTIONS SAMPLE:
${optionTexts.slice(0, 15).map((o, i) => `- ${o}`).join('\n') || 'No options found'}

CTA/BUTTONS:
${ctaElements.slice(0, 10).map((c) => `- "${c}"`).join('\n') || 'No CTA found'}

Provide a structured JSON analysis with these fields:
{
  "totalQuestions": <estimated number of questions in the quiz>,
  "questionTypes": [<list of question types: "multiple_choice", "single_choice", "scale", "open_text", "image_selection", etc>],
  "flowStructure": "<description of the quiz flow: linear, branched, conditional, etc>",
  "resultsLogic": "<how results are calculated/shown: score-based, personality-based, product-recommendation, etc>",
  "designPatterns": [<design patterns used: progress bar, step counter, animations, etc>],
  "ctaElements": [<main CTA elements and their placement>],
  "engagementTechniques": [<engagement techniques: gamification, personalization, urgency, social proof, etc>],
  "recommendations": [<5-7 specific suggestions to replicate or improve this quiz>],
  "rawAnalysis": "<complete narrative analysis of 200-300 words>"
}

IMPORTANT: Reply ONLY with valid JSON, no markdown or additional text.`;

    // Call the agent API for in-depth analysis
    const analyzerResponse = await fetch(
      'https://claude-code-agents.fly.dev/api/agent/run/copy_analyzer',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ prompt }),
      }
    );

    if (!analyzerResponse.ok) {
      return NextResponse.json(
        { success: false, error: `API analyzer error: ${analyzerResponse.status}` },
        { status: 500 }
      );
    }

    const analysisResult = await analyzerResponse.json();

    // Try to parse the JSON response from AI
    let parsedAnalysis = {
      totalQuestions: extractedElements.questions || Math.max(extractedElements.radioInputs / 3, 1),
      questionTypes: ['multiple_choice'],
      flowStructure: 'Linear',
      resultsLogic: 'Score-based',
      designPatterns: extractedElements.progressBars > 0 ? ['progress bar'] : [],
      ctaElements: ctaElements.slice(0, 5),
      engagementTechniques: [],
      recommendations: [],
      rawAnalysis: '',
    };

    try {
      // The API returns an object with a response or result field
      const aiResponse = analysisResult.response || analysisResult.result || analysisResult.output || '';
      
      // Look for JSON in the response
      const jsonMatch = aiResponse.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        const parsed = JSON.parse(jsonMatch[0]);
        parsedAnalysis = {
          ...parsedAnalysis,
          ...parsed,
        };
      } else {
        parsedAnalysis.rawAnalysis = aiResponse;
      }
    } catch {
      // If parsing fails, use rawAnalysis
      parsedAnalysis.rawAnalysis = JSON.stringify(analysisResult);
    }

    return NextResponse.json({
      success: true,
      url,
      name,
      extractedElements,
      questionTexts: questionTexts.slice(0, 10),
      optionSamples: optionTexts.slice(0, 15),
      analysis: parsedAnalysis,
    });
  } catch (error) {
    console.error('Error during quiz analysis:', error);
    return NextResponse.json(
      { success: false, error: 'Error during quiz analysis' },
      { status: 500 }
    );
  }
}
