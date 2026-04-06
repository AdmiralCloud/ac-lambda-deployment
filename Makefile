lint-check:
	./node_modules/.bin/eslint
	
lint-fix:
	./node_modules/.bin/eslint --fix

commit:
	@node ./node_modules/ac-semantic-release/lib/commit.js

release:
	@node ./node_modules/ac-semantic-release/lib/release.js

test-release:
	DEBUGMODE=true node ./node_modules/ac-semantic-release/lib/release.js