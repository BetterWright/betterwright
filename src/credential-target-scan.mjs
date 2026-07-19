export async function disposeCredentialFrameDetections(detections) {
  await Promise.allSettled(
    detections.map(async (detection) => detection.dispose()),
  );
}

export async function collectCredentialFrameDetections({
  frames,
  requestedAction,
  originForFrame,
  detectInFrame,
}) {
  const detections = [];
  try {
    for (const frame of frames) {
      const origin = await originForFrame(frame);
      if (!origin) continue;
      try {
        const detection = await detectInFrame(frame, requestedAction);
        detection.origin = origin;
        detections.push(detection);
      } catch (error) {
        if (!frame.isDetached()) throw error;
      }
    }
    return detections;
  } catch (error) {
    await disposeCredentialFrameDetections(detections);
    throw error;
  }
}
