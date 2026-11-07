/**
 * Parse opening hours string and determine if place is closing soon
 */

interface ClosingSoonInfo {
  isClosingSoon: boolean;
  minutesUntilClose: number | null;
  closingTime: string | null;
}

/**
 * Parse time string like "10:00 PM" or "22:00" to minutes since midnight
 */
function parseTimeToMinutes(timeStr: string): number | null {
  if (!timeStr) return null;
  
  // Handle 24-hour format (e.g., "22:00")
  const match24 = timeStr.match(/^(\d{1,2}):(\d{2})$/);
  if (match24) {
    const hours = parseInt(match24[1], 10);
    const minutes = parseInt(match24[2], 10);
    return hours * 60 + minutes;
  }
  
  // Handle 12-hour format (e.g., "10:00 PM")
  const match12 = timeStr.match(/^(\d{1,2}):(\d{2})\s*(AM|PM)$/i);
  if (match12) {
    let hours = parseInt(match12[1], 10);
    const minutes = parseInt(match12[2], 10);
    const period = match12[3].toUpperCase();
    
    if (period === 'PM' && hours !== 12) hours += 12;
    if (period === 'AM' && hours === 12) hours = 0;
    
    return hours * 60 + minutes;
  }
  
  return null;
}

/**
 * Parse opening hours string and extract closing time
 * Handles formats like:
 * - "10:00 AM - 10:00 PM"
 * - "10:00-22:00"
 * - "Open 24 hours"
 */
function extractClosingTime(openingHours: string): string | null {
  if (!openingHours) return null;
  
  // Check for 24 hours
  if (openingHours.toLowerCase().includes('24')) {
    return null; // Open 24 hours, never closing
  }
  
  // Try to extract closing time from various formats
  // Format: "HH:MM AM - HH:MM PM" or "HH:MM - HH:MM"
  const rangeMatch = openingHours.match(/[-–]\s*(\d{1,2}:\d{2}(?:\s*(?:AM|PM))?)/i);
  if (rangeMatch) {
    return rangeMatch[1].trim();
  }
  
  return null;
}

/**
 * Check if a place is closing soon based on its opening hours
 * @param openingHours - The opening hours string (e.g., "10:00 AM - 10:00 PM")
 * @param thresholdMinutes - Minutes threshold for "closing soon" (default: 60)
 * @returns Object with closing soon status and minutes until close
 */
export function getClosingSoonInfo(
  openingHours: string | undefined,
  thresholdMinutes: number = 60
): ClosingSoonInfo {
  if (!openingHours) {
    return { isClosingSoon: false, minutesUntilClose: null, closingTime: null };
  }
  
  const closingTime = extractClosingTime(openingHours);
  if (!closingTime) {
    return { isClosingSoon: false, minutesUntilClose: null, closingTime: null };
  }
  
  const closeMinutes = parseTimeToMinutes(closingTime);
  if (closeMinutes === null) {
    return { isClosingSoon: false, minutesUntilClose: null, closingTime: null };
  }
  
  const now = new Date();
  const currentMinutes = now.getHours() * 60 + now.getMinutes();
  
  // Handle cases where closing time is after midnight (e.g., 1:00 AM)
  let minutesUntilClose = closeMinutes - currentMinutes;
  if (minutesUntilClose < 0) {
    // Closing time might be tomorrow (past midnight)
    minutesUntilClose += 24 * 60;
  }
  
  // If more than 12 hours until close, it's probably already closed from yesterday
  if (minutesUntilClose > 12 * 60) {
    return { isClosingSoon: false, minutesUntilClose: null, closingTime };
  }
  
  return {
    isClosingSoon: minutesUntilClose <= thresholdMinutes && minutesUntilClose > 0,
    minutesUntilClose,
    closingTime,
  };
}

/**
 * Format minutes until close into a human-readable string
 */
export function formatTimeUntilClose(minutes: number): string {
  if (minutes <= 0) return 'Closing now';
  if (minutes < 60) return `Closes in ${minutes} min`;
  
  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  
  if (remainingMinutes === 0) {
    return `Closes in ${hours}h`;
  }
  return `Closes in ${hours}h ${remainingMinutes}m`;
}
