/**
 * Multi-Agent Quiz Analysis Types
 *
 * The system uses 4 specialized Gemini agents running in parallel,
 * followed by a synthesis step that produces a MasterSpec.
 * Claude then uses the MasterSpec + cloned HTML to transform the quiz.
 */

// =====================================================
// AGENT 1: Visual Design Architect — Pixel-perfect CSS specs
// =====================================================

export interface PixelColorUsage {
  hex: string;
  usage: string;
}

export interface PixelTypography {
  font_family: string;
  font_size: string;
  font_weight: string;
  line_height: string;
  letter_spacing: string;
  color: string;
  text_transform?: string;
}

export interface PixelBorder {
  width: string;
  style: string;
  color: string;
  radius: string;
}

export interface VisualDesignSpec {
  colors: {
    primary: PixelColorUsage;
    secondary: PixelColorUsage;
    accent: PixelColorUsage;
    background_page: string;
    background_card: string;
    text_heading: string;
    text_body: string;
    text_muted: string;
    button_primary_bg: string;
    button_primary_text: string;
    button_primary_hover_bg: string;
    border_default: string;
    border_selected: string;
    progress_fill: string;
    progress_track: string;
    shadow_color: string;
    success: string;
    error: string;
  };
  gradients: Array<{ css: string; usage: string }>;
  typography: {
    heading_h1: PixelTypography;
    heading_h2: PixelTypography;
    heading_h3: PixelTypography;
    body: PixelTypography;
    small: PixelTypography;
    button_text: PixelTypography;
    option_text: PixelTypography;
    label: PixelTypography;
  };
  spacing: {
    page_padding_x: string;
    page_padding_y: string;
    section_gap: string;
    card_padding: string;
    card_padding_mobile: string;
    between_options: string;
    button_padding: string;
    heading_to_subheading: string;
    subheading_to_body: string;
    body_to_cta: string;
    progress_bar_margin: string;
  };
  dimensions: {
    container_max_width: string;
    card_min_height: string;
    button_height: string;
    button_min_width: string;
    progress_bar_height: string;
    icon_size: string;
    option_icon_size: string;
    logo_height: string;
  };
  borders: {
    card_default: PixelBorder;
    card_selected: PixelBorder;
    card_hover: PixelBorder;
    button_primary: PixelBorder;
    button_secondary: PixelBorder;
    progress_bar: { radius: string };
    input_field: PixelBorder;
  };
  shadows: {
    card_default: string;
    card_hover: string;
    card_selected: string;
    button_default: string;
    button_hover: string;
    container: string;
    modal: string;
  };
  animations: {
    step_enter: { type: string; duration: string; easing: string; translate_y?: string; translate_x?: string };
    step_exit: { type: string; duration: string; easing?: string };
    option_hover: { transform: string; duration: string; shadow_change?: string };
    option_select: { type: string; duration: string; scale?: string };
    progress_fill: { duration: string; easing: string };
    result_reveal: { type: string; duration: string; delay?: string };
    loading_spinner: { type: string; duration: string };
  };
  background_patterns: {
    page_has_pattern: boolean;
    pattern_description: string;
    page_background_css: string;
  };
}

// =====================================================
// AGENT 2: UX Flow & Micro-interactions Analyst
// =====================================================

export interface ScreenDefinition {
  index: number;
  type: 'intro_splash' | 'quiz_question' | 'info_screen' | 'social_proof_interstitial' |
        'loading_screen' | 'lead_capture' | 'result_screen' | 'offer_screen' | 'checkout_redirect' | 'other';
  question_type?: 'single_choice' | 'single_choice_with_images' | 'multi_choice' | 'slider' |
                  'text_input' | 'email_input' | 'number_input' | 'date_input' | 'rating' | 'none';
  options_count?: number;
  options_layout?: 'vertical_list' | 'grid_2col' | 'grid_3col' | 'grid_4col' |
                   'horizontal_scroll' | 'single_row' | 'custom';
  has_progress_bar: boolean;
  progress_format?: string;
  auto_advance_on_select: boolean;
  delay_before_advance_ms?: number;
  has_back_button: boolean;
  has_skip_button: boolean;
  cta_required: boolean;
  cta_text?: string;
  estimated_content_height: string;
  special_elements: string[];
}

export interface UXFlowSpec {
  flow_structure: {
    total_screens: number;
    screen_sequence: ScreenDefinition[];
  };
  transitions: {
    between_questions: { exit_animation: string; enter_animation: string; duration_ms: number; direction?: string };
    to_info_screen: { exit_animation: string; enter_animation: string; duration_ms: number };
    to_result: { exit_animation: string; enter_animation: string; duration_ms: number };
    loading_to_result?: { type: string; duration_ms: number; animation_description: string };
  };
  progress_indicator: {
    type: 'continuous_bar' | 'segmented_bar' | 'step_dots' | 'fraction_text' | 'percentage' | 'none';
    position: 'fixed_top' | 'below_header' | 'inline' | 'bottom' | 'none';
    shows_step_count: boolean;
    label_format: string;
    fill_animation: string;
    color_changes_per_step: boolean;
  };
  interaction_patterns: {
    option_select_behavior: string;
    option_deselect_allowed: boolean;
    multi_select_min?: number;
    multi_select_max?: number;
    back_button: { visible: boolean; position: string; style: string };
    keyboard_navigation: boolean;
    swipe_navigation: boolean;
  };
  responsive_behavior: {
    breakpoint_mobile: string;
    breakpoint_tablet: string;
    mobile_layout_changes: string[];
    touch_optimizations: string[];
  };
  loading_states: {
    has_loading_screen: boolean;
    loading_position: string;
    loading_type: string;
    loading_duration_ms: number;
    loading_messages: string[];
  };
}

// =====================================================
// AGENT 3: CRO & Copy Strategist
// =====================================================

export interface CopyElement {
  text: string;
  technique: string;
  emotional_tone: string;
  word_count: number;
  purpose: string;
}

export interface ScreenCopyAnalysis {
  screen_index: number;
  screen_type: string;
  headline: CopyElement | null;
  subheadline: CopyElement | null;
  body_copy: CopyElement | null;
  cta_elements: Array<{
    text: string;
    technique: string;
    position: string;
    is_primary: boolean;
    color_contrast: string;
  }>;
  social_proof_elements: Array<{
    text: string;
    type: 'user_count' | 'rating' | 'testimonial' | 'expert_endorsement' | 'media_mention' | 'statistic' | 'before_after';
    position: string;
    has_icon: boolean;
  }>;
  urgency_elements: Array<{
    text: string;
    type: 'countdown' | 'limited_stock' | 'limited_time' | 'spots_remaining' | 'price_increase' | 'seasonal';
    is_real_or_fake: string;
  }>;
  trust_signals: Array<{
    text: string;
    type: 'guarantee' | 'authority' | 'certification' | 'secure_payment' | 'free_shipping' | 'reviews_count';
    has_icon: boolean;
  }>;
  option_copy?: Array<{
    label: string;
    subtitle?: string;
    emoji_or_icon?: string;
    persuasion_angle: string;
  }>;
  micro_copy: string[];
}

export interface CROSpec {
  copy_architecture: {
    per_screen: ScreenCopyAnalysis[];
  };
  persuasion_flow: {
    stages: Array<{
      stage_name: string;
      screen_indices: number[];
      goal: string;
      techniques: string[];
    }>;
  };
  psychological_techniques_map: Record<string, string[]>;
  overall_copy_style: {
    formality: 'very_formal' | 'formal' | 'conversational' | 'casual' | 'playful';
    person: 'first_person' | 'second_person' | 'third_person';
    sentence_length: 'short' | 'medium' | 'long';
    power_words_frequency: 'low' | 'medium' | 'high';
    emoji_usage: 'none' | 'minimal' | 'moderate' | 'heavy';
    language: string;
  };
  conversion_elements: {
    primary_value_proposition: string;
    main_objection_handled: string;
    key_emotional_trigger: string;
    scarcity_mechanism: string;
    social_proof_strategy: string;
    risk_reversal: string;
  };
}

// =====================================================
// AGENT 4: Quiz Logic Engineer
// =====================================================

export interface QuizQuestion {
  index: number;
  screen_index: number;
  question_text: string;
  question_type: string;
  options: Array<{
    label: string;
    value: string;
    subtitle?: string;
    icon_description?: string;
    maps_to_categories: string[];
    weight?: number;
  }>;
  auto_advance: boolean;
  required: boolean;
  conditional_display?: {
    depends_on_question: number;
    show_if_answer: string[];
  };
}

export interface QuizResultProfile {
  id: string;
  label: string;
  headline: string;
  description: string;
  product_recommendation: string;
  cta_text: string;
  cta_url_pattern: string;
  image_description?: string;
  urgency_element?: string;
  social_proof?: string;
}

export interface QuizLogicSpec {
  quiz_mechanics: {
    scoring_system: 'categorical' | 'weighted_score' | 'branching' | 'simple_count' | 'matrix';
    categories: Array<{
      id: string;
      label: string;
      description: string;
    }>;
    result_determination: string;
    tiebreaker_rule: string;
    scoring_matrix?: Record<string, Record<string, string[]>>;
  };
  questions: QuizQuestion[];
  result_profiles: QuizResultProfile[];
  lead_capture: {
    position: 'before_result' | 'after_result' | 'during_quiz' | 'none';
    required: boolean;
    fields: string[];
    incentive_text: string;
    skip_option: boolean;
    privacy_text: string;
  };
  loading_screen: {
    exists: boolean;
    messages: string[];
    duration_ms: number;
    fake_progress: boolean;
    analysis_labels: string[];
  };
  data_tracking: {
    tracks_answers: boolean;
    sends_to_external: boolean;
    external_service_hints: string[];
    utm_passthrough: boolean;
  };
}

// =====================================================
// MASTER SPEC — Unified output from synthesis agent
// =====================================================

export interface MasterSpec {
  visual: VisualDesignSpec;
  ux_flow: UXFlowSpec;
  cro: CROSpec;
  quiz_logic: QuizLogicSpec;
  synthesis_notes: {
    conflicts_resolved: string[];
    confidence_score: number;
    warnings: string[];
    critical_elements_to_preserve: string[];
  };
  metadata: {
    original_url: string;
    funnel_name: string;
    total_steps: number;
    analyzed_at: string;
    agents_used: string[];
  };
}

// =====================================================
// CLONE-TRANSFORM mode types
// =====================================================

export interface ClonedQuizData {
  html: string;
  title: string;
  cssCount: number;
  imgCount: number;
  renderedSize: number;
}

export interface TextNode {
  index: number;
  originalText: string;
  tagName: string;
  fullTag: string;
  classes: string;
  parentClasses: string;
  position: number;
  isHeadline: boolean;
  isCta: boolean;
  isOption: boolean;
  isSocialProof: boolean;
  isUrgency: boolean;
  context: string;
}

export interface TransformPayload {
  clonedHtml: string;
  textNodes: TextNode[];
  masterSpec: MasterSpec;
  branding: import('@/types').GeneratedBranding;
  product: {
    name: string;
    description: string;
    price: number;
    benefits: string[];
    ctaText: string;
    ctaUrl: string;
    brandName: string;
  };
  extraInstructions?: string;
}

// =====================================================
// V2 PIPELINE TYPES — Visual Replication (no HTML cloning)
// =====================================================

export interface TypographySpec {
  size: string;
  weight: string;
  line_height: string;
  letter_spacing: string;
  text_transform?: string;
}

export interface VisualBlueprint {
  design_system: {
    colors: {
      primary: string;
      secondary: string;
      accent: string;
      background_page: string;
      background_card: string;
      text_heading: string;
      text_body: string;
      text_muted: string;
      button_primary_bg: string;
      button_primary_text: string;
      button_primary_hover: string;
      border_default: string;
      border_selected: string;
      progress_fill: string;
      progress_track: string;
      success: string;
      error: string;
      option_selected_bg: string;
      option_hover_bg: string;
    };
    gradients: Array<{ css: string; applied_to: string }>;
    typography: {
      font_family_primary: string;
      font_family_secondary: string;
      heading_large: TypographySpec;
      heading_medium: TypographySpec;
      heading_small: TypographySpec;
      body: TypographySpec;
      body_small: TypographySpec;
      caption: TypographySpec;
      button: TypographySpec;
      option: TypographySpec;
    };
    spacing: {
      page_padding: string;
      section_gap: string;
      card_padding: string;
      between_options: string;
      button_padding: string;
      heading_margin_bottom: string;
      progress_bar_margin: string;
    };
    dimensions: {
      container_max_width: string;
      button_height: string;
      button_border_radius: string;
      card_border_radius: string;
      progress_bar_height: string;
      progress_bar_border_radius: string;
      input_height: string;
      input_border_radius: string;
    };
    shadows: {
      card_default: string;
      card_hover: string;
      card_selected: string;
      button: string;
      button_hover: string;
    };
    animations: {
      step_transition: { type: string; duration_ms: number; easing: string };
      option_hover: { transform: string; duration_ms: number };
      option_select: { type: string; duration_ms: number };
      progress_fill: { duration_ms: number; easing: string };
      auto_advance_delay_ms: number;
    };
  };
  layout: {
    page_background: string;
    container_style: string;
    has_header: boolean;
    header_content: string;
    option_layout_default: string;
    option_card_style: string;
    option_has_icon_or_emoji: boolean;
    option_icon_position: string;
    cta_button_width: string;
    cta_button_position: string;
  };
  ux_flow: {
    total_screens: number;
    screens: Array<{
      index: number;
      type: string;
      question_type: string;
      options_count: number;
      options_layout: string;
      has_emoji_or_icon: boolean;
      has_progress_bar: boolean;
      progress_format: string;
      has_back_button: boolean;
      auto_advance: boolean;
      cta_text: string | null;
      special_elements: string[];
    }>;
    progress_bar: {
      type: string;
      position: string;
      shows_label: boolean;
      label_format: string;
    };
    transitions: {
      between_steps: { animation: string; duration_ms: number };
      loading_screen: { exists: boolean; duration_ms: number; style: string };
    };
    interaction: {
      option_click: string;
      advance_delay_ms: number;
      back_button_style: string;
      scroll_to_top_on_advance: boolean;
    };
  };
  visual_mood: {
    overall_style: string;
    color_mood: string;
    illustration_style: string;
    emoji_usage: string;
    trust_indicators: string[];
    unique_design_elements: string[];
  };
}

export interface QuizScreenContent {
  index: number;
  type: string;
  headline: string | null;
  subheadline: string | null;
  body_text: string | null;
  question_text: string | null;
  options: Array<{
    label: string;
    subtitle: string | null;
    emoji_or_icon: string | null;
    maps_to_category: string;
  }>;
  cta_text: string | null;
  social_proof: string[];
  trust_elements: string[];
  urgency_elements: string[];
  micro_copy: string[];
  persuasion_techniques: string[];
}

export interface QuizBlueprint {
  quiz_content: {
    language: string;
    screens: QuizScreenContent[];
  };
  scoring_system: {
    type: string;
    categories: Array<{ id: string; label: string; description: string }>;
    result_determination: string;
    tiebreaker: string;
  };
  result_profiles: Array<{
    id: string;
    label: string;
    headline: string;
    description: string;
    product_recommendation: string;
    cta_text: string;
    urgency: string | null;
    social_proof: string | null;
  }>;
  lead_capture: {
    exists: boolean;
    position: string;
    fields: string[];
    incentive_text: string;
    required_or_skippable: string;
  };
  loading_screen: {
    exists: boolean;
    messages: string[];
    has_progress_animation: boolean;
  };
  copy_style: {
    formality: string;
    person: string;
    emoji_frequency: string;
    power_words: string[];
    language: string;
  };
  persuasion_flow: {
    hook_stage: { screens: number[]; techniques: string[] };
    engagement_stage: { screens: number[]; techniques: string[] };
    conversion_stage: { screens: number[]; techniques: string[] };
  };
}

// =====================================================
// Pipeline state for the frontend
// =====================================================

export type MultiAgentPhase =
  | 'idle'
  // V1 legacy phases
  | 'cloning_html'
  | 'capturing_components'
  | 'agent_visual'
  | 'agent_ux_flow'
  | 'agent_cro'
  | 'agent_quiz_logic'
  | 'synthesizing'
  | 'generating_branding'
  | 'transforming_html'
  // V2 new phases
  | 'fetching_screenshots'
  | 'analyzing_visual'
  | 'analyzing_quiz_logic'
  | 'generating_css'
  | 'generating_js'
  | 'generating_html'
  | 'assembling'
  | 'done'
  | 'error';

export const MULTI_AGENT_PHASE_LABELS: Record<MultiAgentPhase, string> = {
  idle: '',
  // V1 legacy
  cloning_html: 'Cloning original HTML with Playwright...',
  capturing_components: 'Capturing per-component screenshot...',
  agent_visual: 'Agent 1: Pixel-perfect Visual Design analysis...',
  agent_ux_flow: 'Agent 2: UX Flow & Interactions analysis...',
  agent_cro: 'Agent 3: CRO & Copy Strategy analysis...',
  agent_quiz_logic: 'Agent 4: Reverse-engineering quiz logic...',
  synthesizing: 'Agent 5: Unified Master Spec synthesis...',
  generating_branding: 'Generating branding for your product...',
  transforming_html: 'Claude: Surgical HTML transformation...',
  // V2 new
  fetching_screenshots: 'Fetching per-step screenshots...',
  analyzing_visual: 'Gemini Vision: Visual blueprint analysis...',
  analyzing_quiz_logic: 'Gemini Vision: Quiz logic & content analysis...',
  generating_css: 'Claude: Generating CSS Design System...',
  generating_js: 'Claude: Generating Quiz Engine JS...',
  generating_html: 'Claude: Generating HTML markup...',
  assembling: 'Final assembly...',
  done: 'Completed!',
  error: 'Error',
};
