export interface CheckInCoords {
  latitude: number;
  longitude: number;
  accuracy?: number;
}

/**
 * Resolves the browser's current position, or throws an Error with a
 * user-facing message describing why location could not be obtained
 * (permission denied, unavailable, timeout, or unsupported browser).
 */
export function getCurrentCoords(): Promise<CheckInCoords> {
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) {
      reject(new Error('Location services are not supported on this device/browser.'));
      return;
    }
    navigator.geolocation.getCurrentPosition(
      (position) => {
        resolve({
          latitude: position.coords.latitude,
          longitude: position.coords.longitude,
          accuracy: position.coords.accuracy,
        });
      },
      (err) => {
        if (err.code === err.PERMISSION_DENIED) {
          reject(new Error('Location permission is required to check in. Please allow location access in your browser settings and try again.'));
        } else if (err.code === err.TIMEOUT) {
          reject(new Error('Could not determine your location in time. Please check your GPS/location settings and try again.'));
        } else {
          reject(new Error('Could not determine your location. Please check your GPS/location settings and try again.'));
        }
      },
      { enableHighAccuracy: true, timeout: 10000, maximumAge: 0 },
    );
  });
}
