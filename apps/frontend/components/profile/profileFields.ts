import type { EmployeeProfile } from '@/types/employeeProfile';

/**
 * The vocabulary the profile screen shares with the API.
 *
 * Pure, so the labelling of a missing field and the shape of an edit can be
 * exercised without a DOM — and so the completion bar and the form cannot end
 * up disagreeing about which fields count.
 */

/**
 * The fields a person maintains about themselves, in the order they are asked
 * for. This mirrors `SELF_MAINTAINED_FIELDS` on the server, which decides the
 * completion percentage; the two lists have to say the same thing or the bar
 * moves without the form changing.
 */
export const SELF_MAINTAINED_FIELDS = [
  'phone',
  'personalEmail',
  'address',
  'dateOfBirth',
  'gender',
  'nationality',
] as const;

export type SelfMaintainedField = (typeof SELF_MAINTAINED_FIELDS)[number];

export const FIELD_LABEL: Record<SelfMaintainedField, string> = {
  phone: 'Phone',
  personalEmail: 'Personal email',
  address: 'Address',
  dateOfBirth: 'Date of birth',
  gender: 'Gender',
  nationality: 'Nationality',
};

/** "Phone, address and 2 more" — what is still blank, in a sentence. */
export function describeMissing(fields: string[], show = 2): string {
  const named = fields
    .filter((field): field is SelfMaintainedField => field in FIELD_LABEL)
    .map((field) => FIELD_LABEL[field].toLowerCase());
  if (named.length === 0) return '';

  const shown = named.slice(0, show);
  const remaining = named.length - shown.length;
  const listed =
    shown.length > 1
      ? `${shown.slice(0, -1).join(', ')} and ${shown[shown.length - 1]}`
      : shown[0];
  return remaining > 0 ? `${listed} and ${remaining} more` : listed;
}

export interface ProfileForm {
  phone: string;
  personalEmail: string;
  address: string;
  dateOfBirth: string;
  gender: string;
  nationality: string;
}

const EMPTY_FORM: ProfileForm = {
  phone: '',
  personalEmail: '',
  address: '',
  dateOfBirth: '',
  gender: '',
  nationality: '',
};

/**
 * Seed the form from the record.
 *
 * `null` becomes `''` because a controlled input given null is an uncontrolled
 * input, and React changes its mind about that mid-edit. The date is truncated
 * to its day: `<input type="date">` refuses a full timestamp outright and
 * silently renders blank.
 */
export function toForm(profile: EmployeeProfile | undefined | null): ProfileForm {
  if (!profile) return { ...EMPTY_FORM };
  return {
    phone: profile.phone ?? '',
    personalEmail: profile.personalEmail ?? '',
    address: profile.address ?? '',
    dateOfBirth: profile.dateOfBirth ? profile.dateOfBirth.slice(0, 10) : '',
    gender: profile.gender ?? '',
    nationality: profile.nationality ?? '',
  };
}

/**
 * The payload for a save — only what actually changed, and nothing empty.
 *
 * Two reasons to send a subset rather than the whole form. An empty string is
 * not "clear this field", it is a field the person never filled in, and posting
 * it would fail `@IsEmail` on personalEmail for everybody who has not given
 * one. And a PATCH that resends unchanged values makes every save look like an
 * edit to anything watching the record.
 */
export function changedFields(
  form: ProfileForm,
  original: ProfileForm,
): Partial<ProfileForm> {
  const payload: Partial<ProfileForm> = {};
  for (const key of Object.keys(form) as Array<keyof ProfileForm>) {
    const value = form[key].trim();
    if (value && value !== original[key]) payload[key] = value;
  }
  return payload;
}

/**
 * Why a form cannot be saved, or nothing.
 *
 * The date of birth is the one rule worth catching here rather than at the
 * boundary: a future birthday is always a typo, and a round trip to be told so
 * loses whatever else the person had typed.
 */
export function validate(
  form: ProfileForm,
  today: string = new Date().toISOString().slice(0, 10),
): Partial<Record<keyof ProfileForm, string>> {
  const errors: Partial<Record<keyof ProfileForm, string>> = {};

  if (form.dateOfBirth && form.dateOfBirth > today) {
    errors.dateOfBirth = 'A date of birth cannot be in the future';
  }
  if (form.nationality && !/^[A-Za-z]{2}$/.test(form.nationality.trim())) {
    errors.nationality = 'Use the two-letter country code, e.g. OM';
  }
  if (form.personalEmail && !form.personalEmail.includes('@')) {
    errors.personalEmail = 'That does not look like an email address';
  }

  return errors;
}
