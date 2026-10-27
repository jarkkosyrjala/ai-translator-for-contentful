import { i18n } from '@lingui/core';

// Contentful's shared field controls use Lingui for their counters and limits.
// Production Lingui does not compile message strings, so these catalog entries
// are stored in its compiled message format.
i18n.loadAndActivate({
  locale: 'en',
  messages: {
    'FieldEditors.Shared.CharCounter.Counter': [
      ['count', 'plural', { one: ['1 character'], other: [['count'], ' characters'] }],
    ],
    'FieldEditors.Shared.CharValidation.MaximumConstraint': ['Maximum ', ['max'], ' characters'],
    'FieldEditors.Shared.CharValidation.MinimumConstraint': ['Requires at least ', ['min'], ' characters'],
    'FieldEditors.Shared.CharValidation.MinMaxConstraint': [
      'Requires between ',
      ['min'],
      ' and ',
      ['max'],
      ' characters',
    ],
    'FieldEditors.Tags.TagsEditorConstraints.RequiresAtLeastNTags': [
      ['0', 'plural', { one: ['Requires at least 1 tag'], other: ['Requires at least ', ['0'], ' tags'] }],
    ],
    'FieldEditors.Tags.TagsEditorConstraints.RequiresNoMoreThanNTags': [
      ['0', 'plural', { one: ['Requires no more than 1 tag'], other: ['Requires no more than ', ['0'], ' tags'] }],
    ],
    'FieldEditors.Tags.TagsEditorConstraints.RequiresExactlyNTags': [
      ['0', 'plural', { one: ['Requires exactly 1 tag'], other: ['Requires exactly ', ['0'], ' tags'] }],
    ],
    'FieldEditors.Tags.TagsEditorConstraints.RequiresBetweenNAndMTags': [
      'Requires between ',
      ['min'],
      ' and ',
      ['max'],
      ' tags',
    ],
  },
});
