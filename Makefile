lint-fix:
	./node_modules/.bin/eslint lambda.js --fix
	
commit:
	@node ./node_modules/ac-semantic-release/lib/commit.js

release:
	@node ./node_modules/ac-semantic-release/lib/release.js

test-release:
	DEBUGMODE=true node ./node_modules/ac-semantic-release/lib/release.js