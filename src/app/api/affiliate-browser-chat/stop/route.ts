import { NextRequest, NextResponse } from 'next/server';

function getApiUrl() {
  return process.env.AGENTIC_BROWSER_API_URL || 'http://localhost:8000';
}

export async function DELETE(request: NextRequest) {
  const API_URL = getApiUrl();
  try {
    const jobId = request.nextUrl.searchParams.get('jobId');

    if (!jobId) {
      return NextResponse.json(
        { success: false, error: 'jobId parameter is required' },
        { status: 400 }
      );
    }

    const response = await fetch(`${API_URL}/jobs/${jobId}`, {
      method: 'DELETE',
    });

    if (!response.ok) {
      if (response.status === 404) {
        return NextResponse.json(
          { success: false, error: 'Job not found' },
          { status: 404 }
        );
      }
      if (response.status === 409) {
        return NextResponse.json(
          { success: false, error: 'Cannot delete a running job' },
          { status: 409 }
        );
      }
      return NextResponse.json(
        { success: false, error: `Agentic API error: ${response.status}` },
        { status: response.status }
      );
    }

    const data = await response.json();

    return NextResponse.json({
      success: true,
      deleted: data.deleted,
    });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return NextResponse.json(
      { success: false, error: `Failed to delete job: ${message}` },
      { status: 500 }
    );
  }
}
